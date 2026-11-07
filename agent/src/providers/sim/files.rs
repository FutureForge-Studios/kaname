//! The in-memory filesystem.
//!
//! Writes persist for the life of the process, which is the point — the
//! file manager, the code editor, the terminal and `site.create` all see
//! the same tree, so editing a vhost in the editor really does change what
//! `site.list` reports.
//!
//! Every path is re-validated here even though the RPC layer already
//! checked it: a provider that trusts its caller is one compromised caller
//! away from being a file-disclosure bug.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use chrono::{DateTime, Utc};
use parking_lot::RwLock;

use super::containers::Container;
use super::state::{MIB, Sim, hash_string, mix, progress, stamp};
use super::system::Identity;
use crate::providers::{
    Ctx, DirectoryListing, Encoding, FileEntry, Files, FsArchiveParams, FsChmodParams, FsChownParams,
    FsCopyParams, FsDownloadParams, FsDownloadResult, FsExtractParams, FsListParams, FsMkdirParams,
    FsMoveParams, FsReadParams, FsReadResult, FsRemoveParams, FsUploadParams, FsUsageParams, FsUsageResult,
    FsWriteParams, PResult, ProviderError, StorageUsageEntry, StreamRef,
};

const MAX_SYMLINK_DEPTH: usize = 32;
const EDITABLE_LIMIT: i64 = 2 * MIB;
const DIR_SIZE: i64 = 4096;

pub type FsRef = Arc<RwLock<MemFs>>;

#[derive(Clone, Debug)]
pub struct Node {
    pub name: String,
    pub kind: String,
    pub mode: String,
    pub uid: i64,
    pub gid: i64,
    pub owner: String,
    pub group: String,
    pub modified: DateTime<Utc>,
    pub data: Vec<u8>,
    /// The declared size of a file whose bytes we do not keep, like a
    /// kernel image or a rotated journal.
    pub virtual_size: i64,
    pub target: String,
    pub children: BTreeMap<String, Node>,
}

impl Node {
    fn blank(name: &str, kind: &str, modified: DateTime<Utc>) -> Node {
        Node {
            name: name.into(),
            kind: kind.into(),
            mode: "0644".into(),
            uid: 0,
            gid: 0,
            owner: "root".into(),
            group: "root".into(),
            modified,
            data: Vec::new(),
            virtual_size: 0,
            target: String::new(),
            children: BTreeMap::new(),
        }
    }

    pub fn directory(name: &str, modified: DateTime<Utc>) -> Node {
        let mut n = Node::blank(name, "directory", modified);
        n.mode = "0755".into();
        n
    }

    pub fn new_file(name: &str, data: Vec<u8>, mode: &str, modified: DateTime<Utc>) -> Node {
        let mut n = Node::blank(name, "file", modified);
        n.mode = mode.into();
        n.data = data;
        n
    }

    pub fn is_dir(&self) -> bool {
        self.kind == "directory"
    }

    pub fn size(&self) -> i64 {
        match self.kind.as_str() {
            "directory" => DIR_SIZE,
            "symlink" => self.target.len() as i64,
            _ => self.virtual_size.max(self.data.len() as i64),
        }
    }

    /// True for a blob whose bytes are synthesised on demand.
    pub fn is_virtual(&self) -> bool {
        self.virtual_size > self.data.len() as i64
    }
}

pub struct MemFs {
    pub root: Node,
    /// Anchors every seeded mtime so a fresh tree looks lived-in rather
    /// than created a millisecond ago.
    pub epoch: DateTime<Utc>,
}

/* ------------------------------ paths -------------------------------- */

/// Go's `path.Clean` for the paths this module sees.
pub fn path_clean(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let rooted = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|s| *s != "..") {
                    out.pop();
                } else if !rooted {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let joined = out.join("/");
    if rooted {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".into()
    } else {
        joined
    }
}

pub fn path_dir(p: &str) -> String {
    let cleaned = path_clean(p);
    match cleaned.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => cleaned[..i].to_string(),
        None => ".".into(),
    }
}

pub fn path_base(p: &str) -> String {
    let cleaned = path_clean(p);
    if cleaned == "/" {
        return "/".into();
    }
    cleaned.rsplit('/').next().unwrap_or_default().to_string()
}

pub fn path_join(a: &str, b: &str) -> String {
    if b.starts_with('/') {
        return path_clean(b);
    }
    if a.is_empty() {
        return path_clean(b);
    }
    path_clean(&format!("{a}/{b}"))
}

pub fn path_ext(name: &str) -> String {
    match name.rfind('.') {
        Some(i) if !name[i..].contains('/') => name[i..].to_string(),
        _ => String::new(),
    }
}

fn segments(p: &str) -> Vec<String> {
    path_clean(p)
        .trim_matches('/')
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .map(str::to_string)
        .collect()
}

/* ------------------------------ seeding ------------------------------ */

impl MemFs {
    pub fn new() -> MemFs {
        let epoch = Utc::now() - chrono::Duration::days(37);
        MemFs {
            root: Node::directory("/", epoch),
            epoch,
        }
    }

    pub fn dir(&mut self, p: &str) {
        self.dir_as(p, "0755", "root", 0);
    }

    pub fn dir_as(&mut self, p: &str, mode: &str, owner: &str, uid: i64) {
        let n = self.mkdir_all(p);
        n.mode = mode.into();
        n.owner = owner.into();
        n.group = owner.into();
        n.uid = uid;
        n.gid = uid;
    }

    pub fn file(&mut self, p: &str, content: &str) {
        self.file_as(p, content, "0644", "root", 0);
    }

    pub fn file_as(&mut self, p: &str, content: &str, mode: &str, owner: &str, uid: i64) {
        let modified =
            self.epoch + chrono::Duration::seconds((mix(p.len() as u64) % (20 * 24 * 3600)) as i64);
        let mut n = Node::new_file(&path_base(p), content.as_bytes().to_vec(), mode, modified);
        n.owner = owner.into();
        n.group = owner.into();
        n.uid = uid;
        n.gid = uid;
        let parent = self.mkdir_all(&path_dir(p));
        parent.children.insert(path_base(p), n);
    }

    /// A file whose bytes are not worth keeping but whose size is: kernel
    /// images, rotated journals, database heaps.
    pub fn blob(&mut self, p: &str, size: i64) {
        let modified =
            self.epoch + chrono::Duration::seconds((mix(p.len() as u64 ^ 0x5a) % (20 * 24 * 3600)) as i64);
        let mut n = Node::new_file(&path_base(p), Vec::new(), "0644", modified);
        n.virtual_size = size;
        let parent = self.mkdir_all(&path_dir(p));
        parent.children.insert(path_base(p), n);
    }

    pub fn link(&mut self, p: &str, target: &str) {
        let mut n = Node::blank(&path_base(p), "symlink", self.epoch);
        n.mode = "0777".into();
        n.target = target.into();
        let parent = self.mkdir_all(&path_dir(p));
        parent.children.insert(path_base(p), n);
    }

    pub fn mkdir_all(&mut self, p: &str) -> &mut Node {
        let epoch = self.epoch;
        let mut cur = &mut self.root;
        for segment in segments(p) {
            let replace = cur.children.get(&segment).is_none_or(|c| !c.is_dir());
            if replace {
                cur.children
                    .insert(segment.clone(), Node::directory(&segment, epoch));
            }
            cur = cur.children.get_mut(&segment).expect("just inserted");
        }
        cur
    }

    /// Removes the child at `p` without following symlinks; returns it.
    pub fn detach(&mut self, p: &str) -> Option<Node> {
        let parent = self.parent_path(p).ok()?;
        let parent = self.node_mut(&parent)?;
        parent.children.remove(&path_base(p))
    }

    /* ----------------------------- resolution ------------------------ */

    /// Resolves a path, following symlinks on every intermediate component
    /// and on the final one when `follow` is set. Depth is bounded so a
    /// cycle fails loudly instead of hanging a request.
    fn walk(&self, p: &str, follow: bool, depth: usize) -> PResult<(&Node, String)> {
        if depth > MAX_SYMLINK_DEPTH {
            return Err(ProviderError::Io(std::io::Error::other(
                "too many levels of symbolic links",
            )));
        }

        let mut cur = &self.root;
        let mut cur_path = String::from("/");
        let segs = segments(p);

        for (i, segment) in segs.iter().enumerate() {
            if !cur.is_dir() {
                return Err(ProviderError::not_found(format!("{cur_path}: not a directory")));
            }
            let Some(child) = cur.children.get(segment) else {
                return Err(ProviderError::not_found(path_join(&cur_path, segment)));
            };

            let last = i == segs.len() - 1;
            if child.kind == "symlink" && (!last || follow) {
                let mut target = child.target.clone();
                if !target.starts_with('/') {
                    target = path_join(&cur_path, &target);
                }
                let mut rest = path_clean(&target);
                for s in &segs[i + 1..] {
                    rest = path_join(&rest, s);
                }
                return self.walk(&rest, follow, depth + 1);
            }

            cur = child;
            cur_path = path_join(&cur_path, segment);
        }
        Ok((cur, cur_path))
    }

    pub fn lookup(&self, p: &str, follow: bool) -> PResult<(&Node, String)> {
        self.walk(p, follow, 0)
    }

    /// Resolves a path's directory to its canonical path, which is what
    /// every mutation needs before it can attach or detach a child.
    pub fn parent_path(&self, p: &str) -> PResult<String> {
        let dir = path_dir(p);
        let (parent, resolved) = self.walk(&dir, true, 0)?;
        if !parent.is_dir() {
            return Err(ProviderError::invalid(format!("{dir}: not a directory")));
        }
        Ok(resolved)
    }

    /// Walks a canonical (symlink-free) path to its node.
    pub fn node_mut(&mut self, canonical: &str) -> Option<&mut Node> {
        let mut cur = &mut self.root;
        for segment in segments(canonical) {
            cur = cur.children.get_mut(&segment)?;
        }
        Some(cur)
    }

    pub fn parent_mut(&mut self, p: &str) -> PResult<&mut Node> {
        let canonical = self.parent_path(p)?;
        self.node_mut(&canonical)
            .ok_or_else(|| ProviderError::not_found(canonical))
    }

    /* ------------------------------ entries -------------------------- */

    pub fn entry(&self, n: &Node, p: &str) -> FileEntry {
        let mut e = FileEntry {
            name: if p == "/" { "/".into() } else { path_base(p) },
            path: p.into(),
            kind: n.kind.clone(),
            size: n.size(),
            mode: n.mode.clone(),
            owner: n.owner.clone(),
            group: n.group.clone(),
            uid: n.uid,
            gid: n.gid,
            modified_at: stamp(n.modified),
            link_target: None,
            child_count: None,
            mime: None,
            is_editable: false,
        };
        if n.kind == "symlink" {
            e.link_target = Some(n.target.clone());
        }
        if n.is_dir() {
            e.child_count = Some(n.children.len() as i64);
        }
        if n.kind == "file" {
            let mime = mime_of(&e.name);
            e.is_editable = e.size <= EDITABLE_LIMIT && n.virtual_size == 0 && is_text_mime(&mime);
            e.mime = Some(mime);
        }
        e
    }
}

impl Default for MemFs {
    fn default() -> Self {
        MemFs::new()
    }
}

fn mime_by_ext() -> &'static HashMap<&'static str, &'static str> {
    static TABLE: once_cell::sync::Lazy<HashMap<&'static str, &'static str>> =
        once_cell::sync::Lazy::new(|| {
            HashMap::from([
                (".html", "text/html"),
                (".htm", "text/html"),
                (".css", "text/css"),
                (".js", "application/javascript"),
                (".mjs", "application/javascript"),
                (".json", "application/json"),
                (".yml", "application/yaml"),
                (".yaml", "application/yaml"),
                (".md", "text/markdown"),
                (".txt", "text/plain"),
                (".log", "text/plain"),
                (".conf", "text/plain"),
                (".cf", "text/plain"),
                (".ini", "text/plain"),
                (".toml", "text/plain"),
                (".sh", "application/x-shellscript"),
                (".php", "application/x-httpd-php"),
                (".py", "text/x-python"),
                (".sql", "application/sql"),
                (".env", "text/plain"),
                (".pem", "application/x-pem-file"),
                (".key", "application/x-pem-file"),
                (".crt", "application/x-x509-ca-cert"),
                (".png", "image/png"),
                (".jpg", "image/jpeg"),
                (".svg", "image/svg+xml"),
                (".ico", "image/vnd.microsoft.icon"),
                (".gz", "application/gzip"),
                (".zst", "application/zstd"),
                (".zip", "application/zip"),
                (".tar", "application/x-tar"),
                (".deb", "application/vnd.debian.binary-package"),
                (".service", "text/plain"),
                (".timer", "text/plain"),
                (".socket", "text/plain"),
            ])
        });
    &TABLE
}

pub fn mime_of(name: &str) -> String {
    let ext = path_ext(name).to_lowercase();
    if let Some(m) = mime_by_ext().get(ext.as_str()) {
        return m.to_string();
    }
    if !name.contains('.') {
        return "text/plain".into();
    }
    "application/octet-stream".into()
}

pub fn is_text_mime(mime: &str) -> bool {
    mime.starts_with("text/")
        || matches!(
            mime,
            "application/json"
                | "application/yaml"
                | "application/javascript"
                | "application/sql"
                | "application/x-shellscript"
                | "application/x-httpd-php"
                | "application/x-pem-file"
        )
}

pub fn tree_size(n: &Node) -> i64 {
    if !n.is_dir() {
        return n.size();
    }
    n.children.values().map(tree_size).sum()
}

pub fn count_nodes(n: &Node) -> i64 {
    if !n.is_dir() {
        return 1;
    }
    1 + n.children.values().map(count_nodes).sum::<i64>()
}

fn apply_recursive(n: &mut Node, recursive: bool, apply: &dyn Fn(&mut Node)) {
    apply(n);
    if !recursive || !n.is_dir() {
        return;
    }
    for child in n.children.values_mut() {
        apply_recursive(child, true, apply);
    }
}

/// Keeps the same name mapping to the same id for the life of the
/// process, which is all a listing needs to look coherent.
pub fn uid_for(name: &str) -> i64 {
    match name {
        "root" => 0,
        "www-data" => 33,
        "postgres" => 108,
        "mysql" => 110,
        "stalwart" => 115,
        "unbound" => 116,
        "deploy" => 1000,
        "alice" => 1001,
        _ => 1000 + (mix(name.len() as u64 ^ hash_string(name)) % 4000) as i64,
    }
}

/// Materialises a blob's bytes on demand so downloading a kernel image
/// produces something of the right size and shape without the tree
/// carrying megabytes of nothing.
pub fn binary_filler(p: &str, size: i64) -> Vec<u8> {
    let size = size.min(8 * MIB).max(0) as usize;
    let mut out = vec![0u8; size];
    let mut seed = mix(p.len() as u64 ^ 0xb10b);
    for (i, b) in out.iter_mut().enumerate() {
        if i % 8 == 0 {
            seed = mix(seed);
        }
        *b = (seed >> (8 * (i % 8))) as u8;
    }
    out
}

/* --------------------------- path validation ------------------------- */

/// Re-validates a path agent-side. The RPC layer already did this; doing
/// it again here means a provider is safe to call directly from a test or
/// a future caller that forgets.
pub fn clean_path(p: &str) -> PResult<String> {
    if p.is_empty() {
        return Err(ProviderError::invalid("path is required"));
    }
    if p.contains('\0') {
        return Err(ProviderError::invalid("path may not contain a null byte"));
    }
    if !p.starts_with('/') {
        return Err(ProviderError::invalid(format!("path must be absolute: {p}")));
    }
    if p.split('/').any(|s| s == "..") {
        return Err(ProviderError::invalid(format!(
            "path may not traverse upwards: {p}"
        )));
    }
    Ok(path_clean(p))
}

pub fn clean_paths(input: &[String]) -> PResult<Vec<String>> {
    input.iter().map(|p| clean_path(p)).collect()
}

/* -------------------------------- files ------------------------------ */

pub struct SimFiles(pub Arc<Sim>);

/// Puts directories first and then sorts by name, which is the order a
/// file manager has to render anyway.
fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        let ad = a.kind == "directory";
        let bd = b.kind == "directory";
        bd.cmp(&ad).then_with(|| a.name.cmp(&b.name))
    });
}

pub fn write_file(
    sim: &Sim,
    target: &str,
    data: Vec<u8>,
    mode: &str,
    create_parents: bool,
) -> PResult<FileEntry> {
    let mut fs = sim.fs.write();
    if create_parents {
        fs.mkdir_all(&path_dir(target));
    }
    let name = path_base(target);
    let parent_path = fs.parent_path(target)?;
    let now = Utc::now();

    let (delta, owner) = {
        let parent = fs
            .node_mut(&parent_path)
            .ok_or_else(|| ProviderError::not_found(parent_path.clone()))?;
        match parent.children.get(&name) {
            Some(existing) if existing.is_dir() => {
                return Err(ProviderError::conflict(format!("{target} is a directory")));
            }
            Some(existing) => (
                data.len() as i64 - existing.size(),
                Some((
                    existing.owner.clone(),
                    existing.group.clone(),
                    existing.uid,
                    existing.gid,
                )),
            ),
            None => (data.len() as i64, None),
        }
    };
    sim.account_bytes(delta);

    let mut n = Node::new_file(&name, data, mode, now);
    if let Some((owner, group, uid, gid)) = owner {
        n.owner = owner;
        n.group = group;
        n.uid = uid;
        n.gid = gid;
    }
    let entry = fs.entry(&n, target);
    let parent = fs
        .node_mut(&parent_path)
        .ok_or_else(|| ProviderError::not_found(parent_path.clone()))?;
    parent.children.insert(name, n);
    Ok(entry)
}

fn default_mode(mode: Option<String>) -> String {
    match mode {
        Some(m) if !m.is_empty() => m,
        _ => "0644".into(),
    }
}

#[async_trait]
impl Files for SimFiles {
    async fn list(&self, _ctx: &Ctx, p: FsListParams) -> PResult<DirectoryListing> {
        let target = clean_path(&p.path)?;
        let fs = self.0.fs.read();
        let (n, resolved) = fs.lookup(&target, true)?;
        if !n.is_dir() {
            return Err(ProviderError::invalid(format!("{target} is not a directory")));
        }

        let mut entries: Vec<FileEntry> = n
            .children
            .iter()
            .filter(|(name, _)| p.show_hidden || !name.starts_with('.'))
            .map(|(name, child)| fs.entry(child, &path_join(&resolved, name)))
            .collect();
        sort_entries(&mut entries);

        let total = entries.len() as i64;
        let mut truncated = false;
        if p.limit > 0 && entries.len() as i64 > p.limit {
            entries.truncate(p.limit as usize);
            truncated = true;
        }

        Ok(DirectoryListing {
            parent: if target == "/" {
                None
            } else {
                Some(path_dir(&target))
            },
            path: target,
            entries,
            truncated,
            total,
        })
    }

    async fn stat(&self, _ctx: &Ctx, path: &str) -> PResult<FileEntry> {
        let target = clean_path(path)?;
        let fs = self.0.fs.read();
        let (n, _) = fs.lookup(&target, false)?;
        Ok(fs.entry(n, &target))
    }

    async fn read(&self, _ctx: &Ctx, p: FsReadParams) -> PResult<FsReadResult> {
        let target = clean_path(&p.path)?;
        let fs = self.0.fs.read();
        let (n, _) = fs.lookup(&target, true)?;
        if n.kind != "file" {
            return Err(ProviderError::invalid(format!("{target} is not a regular file")));
        }

        let mut data: Vec<u8> = if n.is_virtual() {
            binary_filler(&target, n.virtual_size)
        } else {
            n.data.clone()
        };
        let mut truncated = false;
        if p.max_bytes > 0 && data.len() as i64 > p.max_bytes {
            data.truncate(p.max_bytes as usize);
            truncated = true;
        }

        match String::from_utf8(data) {
            Ok(text) => Ok(FsReadResult {
                content: text,
                encoding: "utf8".into(),
                truncated,
                size: n.size(),
            }),
            Err(e) => Ok(FsReadResult {
                content: base64::engine::general_purpose::STANDARD.encode(e.into_bytes()),
                encoding: "base64".into(),
                truncated,
                size: n.size(),
            }),
        }
    }

    async fn write(&self, _ctx: &Ctx, p: FsWriteParams) -> PResult<FileEntry> {
        let target = clean_path(&p.path)?;
        let data = if p.encoding == "base64" {
            base64::engine::general_purpose::STANDARD
                .decode(&p.content)
                .map_err(|_| ProviderError::invalid("content is not valid base64"))?
        } else {
            p.content.into_bytes()
        };
        write_file(&self.0, &target, data, &default_mode(p.mode), p.create_parents)
    }

    async fn mkdir(&self, _ctx: &Ctx, p: FsMkdirParams) -> PResult<FileEntry> {
        let target = clean_path(&p.path)?;
        let mut fs = self.0.fs.write();
        if !p.parents {
            fs.parent_path(&target)?;
        }
        if let Ok((existing, _)) = fs.lookup(&target, false) {
            if !existing.is_dir() {
                return Err(ProviderError::conflict(format!("{target} already exists")));
            }
            return Ok(fs.entry(existing, &target));
        }
        let now = Utc::now();
        let mode = p.mode.filter(|m| !m.is_empty());
        {
            let n = fs.mkdir_all(&target);
            n.modified = now;
            if let Some(mode) = mode {
                n.mode = mode;
            }
        }
        let (n, _) = fs.lookup(&target, false)?;
        Ok(fs.entry(n, &target))
    }

    async fn r#move(&self, _ctx: &Ctx, p: FsMoveParams) -> PResult<FileEntry> {
        let from = clean_path(&p.from)?;
        let to = clean_path(&p.to)?;
        let mut fs = self.0.fs.write();

        let source_path = fs.parent_path(&from)?;
        let from_name = path_base(&from);
        if fs
            .node_mut(&source_path)
            .and_then(|s| s.children.get(&from_name))
            .is_none()
        {
            return Err(ProviderError::not_found(from));
        }
        if from == "/" || to.starts_with(&format!("{from}/")) {
            return Err(ProviderError::invalid(format!("cannot move {from} into itself")));
        }

        let target_path = fs.parent_path(&to)?;
        let name = path_base(&to);
        let clash_size = fs
            .node_mut(&target_path)
            .and_then(|t| t.children.get(&name))
            .map(tree_size);
        if let Some(size) = clash_size {
            if !p.overwrite {
                return Err(ProviderError::conflict(format!("{to} already exists")));
            }
            self.0.account_bytes(-size);
        }

        let mut n = fs
            .node_mut(&source_path)
            .and_then(|s| s.children.remove(&from_name))
            .ok_or_else(|| ProviderError::not_found(from.clone()))?;
        n.name = name.clone();
        n.modified = Utc::now();
        let entry = fs.entry(&n, &to);
        fs.node_mut(&target_path)
            .ok_or_else(|| ProviderError::not_found(target_path.clone()))?
            .children
            .insert(name, n);
        Ok(entry)
    }

    async fn copy(&self, _ctx: &Ctx, p: FsCopyParams) -> PResult<FileEntry> {
        let from = clean_path(&p.from)?;
        let to = clean_path(&p.to)?;
        if to.starts_with(&format!("{from}/")) {
            return Err(ProviderError::invalid(format!("cannot copy {from} into itself")));
        }
        let mut fs = self.0.fs.write();

        let (n, _) = fs.lookup(&from, false)?;
        let mut clone = n.clone();
        let target_path = fs.parent_path(&to)?;
        let name = path_base(&to);
        let clash_size = fs
            .node_mut(&target_path)
            .and_then(|t| t.children.get(&name))
            .map(tree_size);
        if let Some(size) = clash_size {
            if !p.overwrite {
                return Err(ProviderError::conflict(format!("{to} already exists")));
            }
            self.0.account_bytes(-size);
        }

        clone.name = name.clone();
        self.0.account_bytes(tree_size(&clone));
        let entry = fs.entry(&clone, &to);
        fs.node_mut(&target_path)
            .ok_or_else(|| ProviderError::not_found(target_path.clone()))?
            .children
            .insert(name, clone);
        Ok(entry)
    }

    async fn remove(&self, _ctx: &Ctx, p: FsRemoveParams) -> PResult<i64> {
        let targets = clean_paths(&p.paths)?;
        let mut fs = self.0.fs.write();
        let mut removed = 0;
        for target in targets {
            if target == "/" {
                return Err(ProviderError::PermissionDenied("refusing to remove /".into()));
            }
            let parent_path = fs.parent_path(&target)?;
            let name = path_base(&target);
            let parent = fs
                .node_mut(&parent_path)
                .ok_or_else(|| ProviderError::not_found(parent_path.clone()))?;
            let Some(n) = parent.children.get(&name) else {
                return Err(ProviderError::not_found(target));
            };
            if n.is_dir() && !n.children.is_empty() && !p.recursive {
                return Err(ProviderError::conflict(format!("{target} is not empty")));
            }
            let n = parent.children.remove(&name).expect("present");
            self.0.account_bytes(-tree_size(&n));
            removed += count_nodes(&n);
        }
        Ok(removed)
    }

    async fn chmod(&self, _ctx: &Ctx, p: FsChmodParams) -> PResult<()> {
        let targets = clean_paths(&p.paths)?;
        let mut fs = self.0.fs.write();
        for target in targets {
            let (_, resolved) = fs.lookup(&target, false)?;
            let canonical = if resolved == target {
                target.clone()
            } else {
                resolved
            };
            let n = fs
                .node_mut(&canonical)
                .ok_or_else(|| ProviderError::not_found(target.clone()))?;
            let mode = p.mode.clone();
            apply_recursive(n, p.recursive, &|x| x.mode = mode.clone());
        }
        Ok(())
    }

    async fn chown(&self, _ctx: &Ctx, p: FsChownParams) -> PResult<()> {
        let targets = clean_paths(&p.paths)?;
        let owner = p.owner.filter(|o| !o.is_empty());
        let group = p.group.filter(|g| !g.is_empty());
        let mut fs = self.0.fs.write();
        for target in targets {
            let (_, resolved) = fs.lookup(&target, false)?;
            let n = fs
                .node_mut(&resolved)
                .ok_or_else(|| ProviderError::not_found(target.clone()))?;
            apply_recursive(n, p.recursive, &|x| {
                if let Some(owner) = &owner {
                    x.owner = owner.clone();
                    x.uid = uid_for(owner);
                }
                if let Some(group) = &group {
                    x.group = group.clone();
                    x.gid = uid_for(group);
                }
            });
        }
        Ok(())
    }

    async fn archive(&self, ctx: &Ctx, p: FsArchiveParams, s: StreamRef) -> PResult<FileEntry> {
        let sources = clean_paths(&p.paths)?;
        let destination = clean_path(&p.destination)?;

        let (raw, files) = {
            let fs = self.0.fs.read();
            let mut raw = 0i64;
            let mut files = 0i64;
            for source in &sources {
                let (n, _) = fs.lookup(source, true)?;
                raw += tree_size(n);
                files += count_nodes(n);
            }
            (raw, files)
        };

        progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("creating {destination} ({})", p.format),
        )
        .await?;
        for source in &sources {
            progress(ctx, &*s, Duration::from_millis(90), format!("adding: {source}")).await?;
        }

        // Compression ratios differ enough between formats that reporting
        // one number for all three would look wrong next to the real thing.
        let ratio = match p.format.as_str() {
            "tar.gz" => 0.38,
            "tar.zst" => 0.31,
            "zip" => 0.44,
            _ => 0.4,
        };
        let compressed = (raw as f64 * ratio) as i64;

        let entry = {
            let mut fs = self.0.fs.write();
            let name = path_base(&destination);
            let mut n = Node::new_file(&name, Vec::new(), "0644", Utc::now());
            n.virtual_size = compressed;
            let entry = fs.entry(&n, &destination);
            fs.mkdir_all(&path_dir(&destination)).children.insert(name, n);
            entry
        };
        self.0.account_bytes(compressed);

        let _ = progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("wrote {destination} ({files} files, {compressed} bytes)"),
        )
        .await;
        Ok(entry)
    }

    async fn extract(&self, ctx: &Ctx, p: FsExtractParams, s: StreamRef) -> PResult<i64> {
        let source = clean_path(&p.path)?;
        let destination = clean_path(&p.destination)?;

        {
            let fs = self.0.fs.read();
            let (archive, _) = fs.lookup(&source, true)?;
            if archive.kind != "file" {
                return Err(ProviderError::invalid(format!("{source} is not an archive")));
            }
        }

        let base = path_base(&source);
        let base = base.strip_suffix(".gz").unwrap_or(&base);
        let base = base.strip_suffix(".zst").unwrap_or(base);
        let base = base.strip_suffix(".tar").unwrap_or(base);
        let base = base.strip_suffix(".zip").unwrap_or(base).to_string();
        let members = [
            format!("{base}/"),
            format!("{base}/README.md"),
            format!("{base}/index.html"),
            format!("{base}/assets/app.css"),
            format!("{base}/assets/app.js"),
        ];

        progress(
            ctx,
            &*s,
            Duration::ZERO,
            format!("extracting {source} into {destination}"),
        )
        .await?;

        let mut extracted = 0;
        for member in &members {
            let target = path_join(&destination, member);
            progress(
                ctx,
                &*s,
                Duration::from_millis(70),
                format!("  inflating: {target}"),
            )
            .await?;

            {
                let mut fs = self.0.fs.write();
                if member.ends_with('/') {
                    fs.mkdir_all(&target);
                } else {
                    if fs.lookup(&target, false).is_ok() && !p.overwrite {
                        return Err(ProviderError::conflict(format!("{target} already exists")));
                    }
                    let content = format!("extracted from {}\n", path_base(&source));
                    let n = Node::new_file(
                        &path_base(&target),
                        content.clone().into_bytes(),
                        "0644",
                        Utc::now(),
                    );
                    fs.mkdir_all(&path_dir(&target))
                        .children
                        .insert(path_base(&target), n);
                    self.0.account_bytes(content.len() as i64);
                }
            }
            extracted += 1;
        }

        let _ = progress(ctx, &*s, Duration::ZERO, format!("extracted {extracted} entries")).await;
        Ok(extracted)
    }

    async fn download(&self, _ctx: &Ctx, p: FsDownloadParams, s: StreamRef) -> PResult<FsDownloadResult> {
        let target = clean_path(&p.path)?;
        let payload: Vec<u8> = {
            let fs = self.0.fs.read();
            let (n, _) = fs.lookup(&target, true)?;
            if n.kind != "file" {
                return Err(ProviderError::invalid(format!("{target} is not a regular file")));
            }
            if n.is_virtual() {
                binary_filler(&target, n.virtual_size)
            } else {
                n.data.clone()
            }
        };

        const WINDOW: usize = 64 * 1024;
        for piece in payload.chunks(WINDOW) {
            s.send(piece, Encoding::Base64)
                .await
                .map_err(|e| ProviderError::internal(format!("stream {target}: {e}")))?;
        }
        Ok(FsDownloadResult {
            size: payload.len() as i64,
            mime: mime_of(&path_base(&target)),
        })
    }

    async fn upload(&self, _ctx: &Ctx, p: FsUploadParams, s: StreamRef) -> PResult<FileEntry> {
        let target = clean_path(&p.path)?;
        let exists = self.0.fs.read().lookup(&target, false).is_ok();
        if exists && !p.overwrite {
            return Err(ProviderError::conflict(format!("{target} already exists")));
        }

        let mut buffer = Vec::new();
        while let Some(chunk) = s
            .recv()
            .await
            .map_err(|e| ProviderError::internal(format!("receive upload for {target}: {e}")))?
        {
            buffer.extend_from_slice(&chunk);
            if p.size > 0 && buffer.len() as i64 > p.size {
                return Err(ProviderError::invalid(format!(
                    "upload exceeded the declared {} bytes",
                    p.size
                )));
            }
        }

        write_file(&self.0, &target, buffer, &default_mode(p.mode), true)
    }

    async fn usage(&self, _ctx: &Ctx, p: FsUsageParams) -> PResult<FsUsageResult> {
        let target = clean_path(&p.path)?;
        let fs = self.0.fs.read();
        let (root, resolved) = fs.lookup(&target, true)?;

        let mounts: Vec<&str> = self.0.id.disks.iter().map(|d| d.mount).collect();
        let mut entries = Vec::new();
        collect(root, &resolved, 1, p.depth, &mounts, &mut entries);
        entries.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        Ok(FsUsageResult {
            entries,
            total: tree_size(root),
        })
    }
}

fn collect(
    n: &Node,
    at: &str,
    depth: i64,
    max_depth: i64,
    mounts: &[&str],
    out: &mut Vec<StorageUsageEntry>,
) {
    if !n.is_dir() || depth > max_depth {
        return;
    }
    for (name, child) in &n.children {
        let child_path = path_join(at, name);
        let kind = if mounts.contains(&child_path.as_str()) {
            "mount"
        } else if !child.is_dir() {
            "category"
        } else {
            "directory"
        };
        out.push(StorageUsageEntry {
            path: child_path.clone(),
            bytes: tree_size(child),
            inodes: Some(count_nodes(child)),
            kind: kind.into(),
            label: None,
        });
        collect(child, &child_path, depth + 1, max_depth, mounts, out);
    }
}

/* ---------------------------- the host tree -------------------------- */

/// Lays out a believable Debian host. It is deliberately wide rather than
/// deep: the file manager, the terminal and the editor all want somewhere
/// real to go.
pub fn build_filesystem(id: &Identity) -> FsRef {
    let mut f = MemFs::new();
    let short = id.hostname.split('.').next().unwrap_or_default().to_string();

    for d in [
        "/boot",
        "/dev",
        "/etc",
        "/home",
        "/media",
        "/mnt",
        "/opt",
        "/proc",
        "/root",
        "/run",
        "/srv",
        "/sys",
        "/tmp",
        "/usr",
        "/var",
        "/lost+found",
    ] {
        f.dir(d);
    }
    f.dir_as("/root", "0700", "root", 0);
    f.dir_as("/tmp", "1777", "root", 0);

    f.link("/bin", "usr/bin");
    f.link("/sbin", "usr/sbin");
    f.link("/lib", "usr/lib");

    /* --------------------------- /boot ---------------------------- */
    f.blob("/boot/vmlinuz-6.1.0-18-amd64", 8_284_672);
    f.blob("/boot/initrd.img-6.1.0-18-amd64", 42_118_912);
    f.blob("/boot/System.map-6.1.0-18-amd64", 5_412_336);
    f.file(
        "/boot/config-6.1.0-18-amd64",
        "CONFIG_LOCALVERSION=\"-18-amd64\"\nCONFIG_64BIT=y\nCONFIG_X86_64=y\nCONFIG_SMP=y\n",
    );
    f.file("/boot/grub/grub.cfg", "set default=\"0\"\nset timeout=5\n\nmenuentry 'Debian GNU/Linux' {\n\tlinux /boot/vmlinuz-6.1.0-18-amd64 root=/dev/vda1 ro quiet\n\tinitrd /boot/initrd.img-6.1.0-18-amd64\n}\n");

    /* ---------------------------- /etc ---------------------------- */
    f.file("/etc/os-release", "PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\nNAME=\"Debian GNU/Linux\"\nVERSION_ID=\"12\"\nVERSION=\"12 (bookworm)\"\nVERSION_CODENAME=bookworm\nID=debian\nHOME_URL=\"https://www.debian.org/\"\nSUPPORT_URL=\"https://www.debian.org/support\"\nBUG_REPORT_URL=\"https://bugs.debian.org/\"\n");
    f.file("/etc/hostname", &format!("{short}\n"));
    f.file(
        "/etc/hosts",
        &format!(
            "127.0.0.1\tlocalhost\n127.0.1.1\t{} {}\n{}\t{}\n\n::1\tlocalhost ip6-localhost ip6-loopback\nff02::1\tip6-allnodes\nff02::2\tip6-allrouters\n",
            id.hostname, short, id.private_ip, id.hostname
        ),
    );
    f.file("/etc/machine-id", &format!("{}\n", id.machine_id));
    f.file("/etc/timezone", &format!("{}\n", id.timezone));
    f.file(
        "/etc/resolv.conf",
        "nameserver 127.0.0.1\noptions edns0 trust-ad\nsearch kaname.internal\n",
    );
    f.file("/etc/fstab", "# /etc/fstab: static file system information.\nUUID=9f2c1b70-4d5e-4b21-9c0a-2f1a7e6d4c33 /               ext4    errors=remount-ro 0 1\nUUID=1a4d-9C2E                            /boot           ext4    defaults          0 2\nUUID=c81f9a5d-3e7b-4f10-8a26-5d9e0c4b7a12 /srv            xfs     defaults,noatime  0 2\nUUID=7b3e2c41-8f6a-4d09-b52c-16e8d3f0a945 /var/lib/docker ext4    defaults          0 2\n/dev/vda3                                 none            swap    sw                0 0\n");
    f.file("/etc/passwd", "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nbin:x:2:2:bin:/bin:/usr/sbin/nologin\nsys:x:3:3:sys:/dev:/usr/sbin/nologin\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\nmessagebus:x:100:107::/nonexistent:/usr/sbin/nologin\nsshd:x:104:65534::/run/sshd:/usr/sbin/nologin\npostgres:x:108:117:PostgreSQL administrator,,,:/var/lib/postgresql:/bin/bash\nmysql:x:110:120:MariaDB Server,,,:/nonexistent:/bin/false\nstalwart:x:115:125:Stalwart Mail Server,,,:/opt/stalwart:/usr/sbin/nologin\nunbound:x:116:126::/var/lib/unbound:/usr/sbin/nologin\ndeploy:x:1000:1000:Deploy,,,:/home/deploy:/bin/bash\nalice:x:1001:1001:Alice Nakamura,,,:/home/alice:/bin/bash\n");
    f.file("/etc/group", "root:x:0:\nadm:x:4:deploy,alice\nsudo:x:27:deploy\nwww-data:x:33:deploy\nshadow:x:42:\nstalwart:x:125:\nunbound:x:126:\ndocker:x:998:deploy\ndeploy:x:1000:\nalice:x:1001:\n");
    // The hashes are placeholders on purpose: nothing in a simulated host
    // should ever look like a credential worth trying somewhere else.
    f.file_as("/etc/shadow", "root:*:19800:0:99999:7:::\ndaemon:*:19800:0:99999:7:::\nwww-data:*:19800:0:99999:7:::\ndeploy:!:19850:0:99999:7:::\nalice:!:19851:0:99999:7:::\n", "0640", "root", 0);
    f.file("/etc/crontab", "SHELL=/bin/sh\nPATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin\n\n17 *\t* * *\troot\tcd / && run-parts --report /etc/cron.hourly\n25 6\t* * *\troot\ttest -x /usr/sbin/anacron || run-parts --report /etc/cron.daily\n12 3\t* * *\tdeploy\t/usr/local/bin/kaname-nightly.sh >/dev/null 2>&1\n");
    f.file("/etc/sudoers", "Defaults\tenv_reset\nDefaults\tsecure_path=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\"\n\nroot\tALL=(ALL:ALL) ALL\n%sudo\tALL=(ALL:ALL) ALL\n");
    f.file("/etc/apt/sources.list", "deb http://deb.debian.org/debian bookworm main contrib non-free-firmware\ndeb http://deb.debian.org/debian bookworm-updates main contrib non-free-firmware\ndeb http://security.debian.org/debian-security bookworm-security main contrib non-free-firmware\n");
    f.file("/etc/apt/sources.list.d/docker.list", "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n");

    f.file("/etc/nginx/nginx.conf", NGINX_MAIN_CONFIG);
    f.dir("/etc/nginx/conf.d");
    f.dir("/etc/nginx/sites-available");
    f.dir("/etc/nginx/sites-enabled");
    f.file("/etc/nginx/snippets/ssl-params.conf", "ssl_protocols TLSv1.2 TLSv1.3;\nssl_prefer_server_ciphers off;\nssl_session_cache shared:SSL:10m;\nssl_session_timeout 1d;\nadd_header Strict-Transport-Security \"max-age=63072000\" always;\n");
    f.blob("/etc/nginx/mime.types", 5_349);

    f.file("/etc/ssh/sshd_config", SSHD_CONFIG_FILE);
    f.file(
        "/etc/ssh/ssh_host_ed25519_key.pub",
        &format!(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1sIm9kQ2Fq7Rr0dY6vQ3sT8xN4mZ5wLpCe2hUjKt0F root@{}\n",
            id.hostname
        ),
    );
    f.file_as("/etc/ssh/ssh_host_ed25519_key", "-----BEGIN OPENSSH PRIVATE KEY-----\n(simulated host key; no key material is kept)\n-----END OPENSSH PRIVATE KEY-----\n", "0600", "root", 0);

    // Yunori Mail Server: the console's own config, Stalwart underneath
    // it, and the local resolver it insists on.
    f.file_as(
        "/etc/yunori-mail/config.toml",
        &yunori_config(id),
        "0640",
        "root",
        0,
    );
    f.dir_as("/var/lib/yunori-mail", "0700", "root", 0);
    f.blob("/var/lib/yunori-mail/state.sqlite", 1_179_648);
    f.file_as(
        "/var/lib/yunori-mail/vault.age",
        "age-encryption.org/v1\n(simulated; no secrets are kept)\n",
        "0600",
        "root",
        0,
    );
    f.dir_as("/opt/stalwart", "0750", "stalwart", 115);
    f.file_as(
        "/opt/stalwart/etc/config.toml",
        STALWART_CONFIG,
        "0640",
        "stalwart",
        115,
    );
    f.blob("/opt/stalwart/bin/stalwart-mail", 48_234_496);
    f.dir_as("/opt/stalwart/data", "0700", "stalwart", 115);
    f.blob("/opt/stalwart/data/blobs/index.db", 268_435_456);
    f.file("/etc/unbound/unbound.conf.d/yunori.conf", UNBOUND_CONFIG);
    f.file("/etc/systemd/system/stalwart-mail.service", "[Unit]\nDescription=Stalwart Mail Server\nAfter=network-online.target unbound.service\n\n[Service]\nType=simple\nUser=stalwart\nExecStart=/opt/stalwart/bin/stalwart-mail --config /opt/stalwart/etc/config.toml\nRestart=on-failure\nLimitNOFILE=65536\n\n[Install]\nWantedBy=multi-user.target\n");
    f.file("/etc/systemd/system/yunori-mail.service", "[Unit]\nDescription=Yunori Mail Server console and edge\nAfter=network-online.target stalwart-mail.service\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/yunori-mail serve\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=multi-user.target\n");

    f.file("/etc/postgresql/16/main/postgresql.conf", "data_directory = '/var/lib/postgresql/16/main'\nhba_file = '/etc/postgresql/16/main/pg_hba.conf'\nport = 5432\nmax_connections = 100\nshared_buffers = 512MB\nwork_mem = 8MB\nwal_level = replica\nlog_line_prefix = '%m [%p] %q%u@%d '\n");
    f.file("/etc/postgresql/16/main/pg_hba.conf", "local   all             postgres                                peer\nlocal   all             all                                     scram-sha-256\nhost    all             all             127.0.0.1/32            scram-sha-256\nhost    all             all             ::1/128                 scram-sha-256\n");
    f.file("/etc/mysql/mariadb.conf.d/50-server.cnf", "[mysqld]\nbind-address = 127.0.0.1\nmax_connections = 151\ninnodb_buffer_pool_size = 512M\ncharacter-set-server = utf8mb4\ncollation-server = utf8mb4_general_ci\n");

    f.file("/etc/nftables.conf", NFTABLES_CONFIG);
    f.file("/etc/fail2ban/jail.local", "[DEFAULT]\nbantime  = 1h\nfindtime = 10m\nmaxretry = 5\nbackend  = systemd\n\n[sshd]\nenabled = true\n\n[nginx-http-auth]\nenabled = true\n\n[stalwart-mail]\nenabled = true\n");
    f.file("/etc/logrotate.d/nginx", "/var/log/nginx/*.log {\n\tdaily\n\tmissingok\n\trotate 14\n\tcompress\n\tdelaycompress\n\tnotifempty\n\tcreate 0640 www-data adm\n}\n");
    f.file("/etc/systemd/system/kanamed.service", "[Unit]\nDescription=Kaname agent\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=/usr/local/bin/kanamed run\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n");
    f.dir("/etc/letsencrypt/live");
    f.dir("/etc/letsencrypt/archive");
    f.file_as(
        "/etc/kaname/agent.env",
        "KANAME_URL=https://panel.kaname.internal\nKANAME_LOG_LEVEL=info\n",
        "0640",
        "root",
        0,
    );

    /* --------------------------- /home ---------------------------- */
    for (name, uid) in [("deploy", 1000), ("alice", 1001)] {
        let home = format!("/home/{name}");
        f.dir_as(&home, "0750", name, uid);
        f.file_as(&format!("{home}/.bashrc"), "# ~/.bashrc\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\nexport PS1='\\u@\\h:\\w\\$ '\nalias ll='ls -alF'\n", "0644", name, uid);
        f.file_as(&format!("{home}/.profile"), "if [ -n \"$BASH_VERSION\" ] && [ -f \"$HOME/.bashrc\" ]; then\n\t. \"$HOME/.bashrc\"\nfi\nPATH=\"$HOME/.local/bin:$PATH\"\n", "0644", name, uid);
        f.dir_as(&format!("{home}/.ssh"), "0700", name, uid);
        f.file_as(
            &format!("{home}/.ssh/authorized_keys"),
            &format!("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIC7yQ4pXvR2mK9dLwB6nT1sZ0hEaJ3fUgMxOiPqV8rYd {name}@workstation\n"),
            "0600",
            name,
            uid,
        );
    }
    f.dir_as("/home/deploy/projects/storefront", "0755", "deploy", 1000);
    f.file_as("/home/deploy/projects/storefront/README.md", "# storefront\n\nDeployed to /var/www/example.com by the nightly job.\n\n    pnpm install\n    pnpm build\n", "0644", "deploy", 1000);
    f.file_as("/home/deploy/projects/storefront/package.json", "{\n  \"name\": \"storefront\",\n  \"version\": \"2.4.1\",\n  \"private\": true,\n  \"scripts\": {\n    \"build\": \"vite build\",\n    \"dev\": \"vite\"\n  }\n}\n", "0644", "deploy", 1000);
    f.file_as("/home/deploy/deploy.sh", "#!/bin/sh\nset -eu\ncd /home/deploy/projects/storefront\ngit pull --ff-only\npnpm install --frozen-lockfile\npnpm build\nrsync -a --delete dist/ /var/www/example.com/public/\nsystemctl reload nginx\n", "0755", "deploy", 1000);

    f.file_as(
        "/root/.bashrc",
        "export PS1='\\[\\e[1;31m\\]\\u@\\h\\[\\e[0m\\]:\\w# '\nalias ll='ls -alF'\nalias la='ls -A'\n",
        "0644",
        "root",
        0,
    );
    f.file_as("/root/.profile", ". \"$HOME/.bashrc\"\n", "0644", "root", 0);
    f.dir_as("/root/.ssh", "0700", "root", 0);
    f.file_as(
        "/root/.ssh/authorized_keys",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFq8xJ2vZ9nR0dTgY6mC1sL4pW7hB3eKuQaXrN5tOiVd ops@kaname\n",
        "0600",
        "root",
        0,
    );

    /* ---------------------------- /var ---------------------------- */
    f.dir("/var/backups");
    f.blob("/var/backups/apt.extended_states.0", 62_118);
    f.dir_as("/var/www", "0755", "www-data", 33);
    f.dir("/var/lib/docker/containers");
    f.dir("/var/lib/docker/overlay2");
    f.dir_as("/var/lib/postgresql/16/main", "0700", "postgres", 108);
    f.blob("/var/lib/postgresql/16/main/pg_wal", 402_653_184);
    f.dir_as("/var/lib/mysql", "0700", "mysql", 110);
    f.blob("/var/lib/mysql/ibdata1", 79_691_776);
    f.dir_as("/var/lib/unbound", "0755", "unbound", 116);
    f.blob("/var/lib/unbound/root.key", 1_088);
    f.dir("/var/spool/cron/crontabs");
    f.dir("/var/cache/apt/archives");

    f.blob("/var/log/syslog", 18_432_112);
    f.blob("/var/log/syslog.1", 41_119_744);
    f.blob("/var/log/auth.log", 2_884_213);
    f.blob("/var/log/dpkg.log", 1_204_338);
    f.blob("/var/log/kern.log", 3_918_204);
    f.dir_as("/var/log/nginx", "0750", "www-data", 33);
    f.blob("/var/log/nginx/access.log", 214_884_112);
    f.blob("/var/log/nginx/error.log", 4_118_223);
    f.blob("/var/log/nginx/access.log.1", 188_291_072);
    f.blob(
        &format!("/var/log/journal/{}/system.journal", id.machine_id),
        117_440_512,
    );
    f.blob(
        &format!("/var/log/journal/{}/user-1000.journal", id.machine_id),
        8_388_608,
    );

    /* ---------------------------- /srv ---------------------------- */
    f.dir("/srv/minio/kaname-backups");
    f.dir("/srv/uptime-kuma");
    f.dir("/srv/n8n");
    f.blob("/srv/backups/kaname-2026-08-25.tar.zst", 4_294_967_296);

    /* ---------------------------- /usr ---------------------------- */
    f.dir("/usr/local/bin");
    f.dir("/usr/share/nginx");
    for (name, size) in [
        ("bash", 1_265_648),
        ("cat", 43_936),
        ("ls", 142_144),
        ("grep", 199_720),
        ("sed", 129_768),
        ("awk", 694_320),
        ("tar", 499_072),
        ("curl", 253_616),
        ("git", 3_723_048),
        ("psql", 727_800),
        ("systemctl", 1_035_896),
        ("journalctl", 92_312),
        ("docker", 65_339_392),
        ("python3", 7_968),
        ("node", 92_450_816),
    ] {
        f.blob(&format!("/usr/bin/{name}"), size);
    }
    for (name, size) in [
        ("sshd", 924_120),
        ("nginx", 1_285_680),
        ("unbound", 1_034_112),
        ("nft", 226_808),
        ("cron", 55_824),
        ("service", 9_136),
    ] {
        f.blob(&format!("/usr/sbin/{name}"), size);
    }
    f.blob("/usr/local/bin/kanamed", 12_582_912);
    f.blob("/usr/local/bin/yunori-mail", 18_874_368);
    f.file_as(
        "/usr/local/bin/kaname-nightly.sh",
        "#!/bin/sh\nset -eu\n/usr/local/bin/kanamed version\nrestic backup /var/www /etc --tag nightly\n",
        "0755",
        "root",
        0,
    );

    /* -------------------- procfs, close enough -------------------- */
    f.file(
        "/proc/version",
        &format!(
            "Linux version {} (debian-kernel@lists.debian.org) (gcc-12 (Debian 12.2.0-14) 12.2.0) #1 SMP PREEMPT_DYNAMIC Debian 6.1.76-1 (2024-02-01)\n",
            id.kernel
        ),
    );
    f.file("/proc/cpuinfo", &cpuinfo_file(id));
    f.file("/proc/meminfo", &meminfo_file(id));
    f.file("/proc/mounts", "/dev/vda1 / ext4 rw,relatime,errors=remount-ro 0 0\n/dev/vda2 /boot ext4 rw,relatime 0 0\n/dev/vdb1 /srv xfs rw,noatime 0 0\n/dev/vdc1 /var/lib/docker ext4 rw,relatime 0 0\n");

    Arc::new(RwLock::new(f))
}

fn cpuinfo_file(id: &Identity) -> String {
    let mut b = String::new();
    for core in 0..id.cpu_cores {
        b.push_str(&format!(
            "processor\t: {core}\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel name\t: {}\ncpu MHz\t\t: 2900.000\ncache size\t: 55296 KB\nsiblings\t: {}\ncore id\t\t: {core}\nflags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat\n\n",
            id.cpu_model, id.cpu_cores
        ));
    }
    b
}

fn meminfo_file(id: &Identity) -> String {
    let total = id.memory_total / super::state::KIB;
    let swap = id.swap_total / super::state::KIB;
    format!(
        "MemTotal:       {:8} kB\nMemFree:        {:8} kB\nMemAvailable:   {:8} kB\nBuffers:        {:8} kB\nCached:         {:8} kB\nSwapTotal:      {:8} kB\nSwapFree:       {:8} kB\n",
        total,
        total * 22 / 100,
        total * 49 / 100,
        total * 3 / 100,
        total * 24 / 100,
        swap,
        swap * 93 / 100
    )
}

/// Gives `container.exec` somewhere honest to land: the container's own
/// root, not the host's.
pub fn build_container_filesystem(c: &Container) -> FsRef {
    let mut f = MemFs::new();
    for d in [
        "/bin",
        "/dev",
        "/etc",
        "/proc",
        "/root",
        "/sys",
        "/tmp",
        "/usr/bin",
        "/usr/local/bin",
        "/var/log",
    ] {
        f.dir(d);
    }
    let short = &c.info.id[..12];
    f.file("/etc/hostname", &format!("{short}\n"));
    f.file(
        "/etc/hosts",
        &format!("127.0.0.1\tlocalhost\n172.18.0.2\t{short}\n"),
    );
    f.file(
        "/etc/os-release",
        "PRETTY_NAME=\"Alpine Linux v3.20\"\nNAME=\"Alpine Linux\"\nID=alpine\nVERSION_ID=3.20.1\n",
    );
    f.file("/etc/resolv.conf", "nameserver 127.0.0.11\noptions ndots:0\n");
    for name in ["sh", "ls", "cat", "env"] {
        f.blob(&format!("/bin/{name}"), 812_408);
    }
    f.blob(&format!("/usr/local/bin/{}", c.process), 24_117_248);

    let image = &c.info.image;
    if image.starts_with("redis") {
        f.blob("/data/dump.rdb", 18_874_368);
        f.file(
            "/etc/redis.conf",
            "bind 0.0.0.0\nport 6379\nappendonly yes\nsave 900 1\n",
        );
    } else if image.starts_with("minio") {
        f.dir("/data/kaname-backups");
    } else if image.contains("uptime-kuma") || image.contains("n8n") {
        f.file(
            "/app/package.json",
            &format!("{{\n  \"name\": \"{}\",\n  \"private\": true\n}}\n", c.info.name),
        );
        f.blob("/app/server/server.js", 284_112);
    }
    Arc::new(RwLock::new(f))
}

/* --------------------------- config bodies --------------------------- */

pub const NGINX_MAIN_CONFIG: &str = "user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 1024;
    multi_accept on;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;
    server_tokens off;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    access_log /var/log/nginx/access.log;
    error_log  /var/log/nginx/error.log;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript image/svg+xml;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
";

pub const SSHD_CONFIG_FILE: &str = "Include /etc/ssh/sshd_config.d/*.conf

Port 22
AddressFamily any
ListenAddress 0.0.0.0

PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
MaxAuthTries 4
AllowUsers root deploy

UsePAM yes
X11Forwarding no
PrintMotd no
ClientAliveInterval 300
ClientAliveCountMax 2

AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server
";

pub const NFTABLES_CONFIG: &str = "#!/usr/sbin/nft -f
flush ruleset

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;
        ct state established,related accept
        iif \"lo\" accept
        ip protocol icmp accept
        tcp dport { 22, 25, 80, 443, 465, 587, 993 } accept
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}
";

pub const STALWART_CONFIG: &str = "# Managed by yunori-mail; edit through the console or `yunori-mail`.
[server]
hostname = \"%{env:YUNORI_HOSTNAME}%\"

[server.listener.\"smtp\"]
bind = [\"[::]:25\"]
protocol = \"smtp\"

[server.listener.\"submissions\"]
bind = [\"[::]:465\"]
protocol = \"smtp\"
tls.implicit = true

[server.listener.\"submission\"]
bind = [\"[::]:587\"]
protocol = \"smtp\"

[server.listener.\"imaptls\"]
bind = [\"[::]:993\"]
protocol = \"imap\"
tls.implicit = true

[server.listener.\"http\"]
bind = [\"127.0.0.1:8080\"]
protocol = \"http\"

[storage]
data = \"rocksdb\"
fts = \"rocksdb\"
blob = \"rocksdb\"
lookup = \"rocksdb\"
directory = \"internal\"

[store.\"rocksdb\"]
type = \"rocksdb\"
path = \"/opt/stalwart/data\"

[resolver]
type = \"custom\"
custom = [\"127.0.0.1:53\"]

[tracer.\"journal\"]
type = \"journal\"
level = \"info\"
";

pub const UNBOUND_CONFIG: &str = "# Installed by yunori-mail: a local validating resolver so DNSBL and
# DKIM lookups are never answered from a public resolver's cache.
server:
    interface: 127.0.0.1
    access-control: 127.0.0.0/8 allow
    do-ip6: no
    qname-minimisation: yes
    harden-dnssec-stripped: yes
    cache-min-ttl: 60
";

pub fn yunori_config(id: &Identity) -> String {
    format!(
        "# Yunori Mail Server
[server]
hostname = \"mail.{domain}\"
console_bind = \"127.0.0.1:8443\"
public_ip = \"{ip}\"

[paths]
state = \"/var/lib/yunori-mail/state.sqlite\"
vault = \"/var/lib/yunori-mail/vault.age\"
stalwart = \"/opt/stalwart\"

[sending]
mode = \"direct\"

[tls]
authority = \"letsencrypt\"
contact = \"admin@{domain}\"
",
        domain = id.mail_domain,
        ip = super::mail::MAIL_IP
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_helpers_match_go() {
        assert_eq!(path_clean("/a//b/./c/"), "/a/b/c");
        assert_eq!(path_clean("/a/b/../c"), "/a/c");
        assert_eq!(path_clean("/"), "/");
        assert_eq!(path_dir("/a/b/c"), "/a/b");
        assert_eq!(path_dir("/a"), "/");
        assert_eq!(path_base("/a/b/c"), "c");
        assert_eq!(path_base("/"), "/");
        assert_eq!(path_join("/a", "b/c"), "/a/b/c");
        assert_eq!(path_join("/a", "/b"), "/b");
        assert_eq!(path_ext("app.tar.gz"), ".gz");
        assert_eq!(path_ext("README"), "");
    }

    #[test]
    fn symlinks_resolve_and_loops_fail() {
        let mut f = MemFs::new();
        f.dir("/usr/bin");
        f.file("/usr/bin/ls", "x");
        f.link("/bin", "usr/bin");
        let (n, resolved) = f.lookup("/bin/ls", true).unwrap();
        assert_eq!(n.kind, "file");
        assert_eq!(resolved, "/usr/bin/ls");
        let (n, _) = f.lookup("/bin", false).unwrap();
        assert_eq!(n.kind, "symlink");

        f.link("/loop", "/loop");
        assert!(f.lookup("/loop", true).is_err());
    }

    #[test]
    fn clean_path_rejects_traversal() {
        assert!(clean_path("/etc/../etc/passwd").is_err());
        assert!(clean_path("etc/passwd").is_err());
        assert!(clean_path("").is_err());
        assert_eq!(clean_path("/etc//passwd").unwrap(), "/etc/passwd");
    }
}
