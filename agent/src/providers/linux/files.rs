//! Files on a real host.
//!
//! Every path is re-validated here even though the RPC layer already
//! checked it: the agent must not be walkable out of bounds by a control
//! plane that has been compromised. Writes are atomic (temp, fsync,
//! rename) so a crash never leaves a half-written config behind, and
//! archive extraction refuses any member that would land outside the
//! destination.
//!
//! The archive code lives here too (creation at the bottom of the file,
//! extraction in the `archive` section). An archive is attacker-controlled
//! input by the time it reaches a host: an operator uploads what a
//! customer sent them and asks the panel to unpack it. Two things
//! therefore hold for every member. Its name is resolved against the
//! destination and clamped there, so a `../` or an absolute path lands
//! inside rather than beside. And a symlink member is refused outright if
//! the link would resolve out of the destination, because a later member
//! can be written *through* it.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::common::{epoch_rfc3339, invalid, is_not_exist, not_found, unsupported};
use super::exec::{sync_dir, write_atomic};
use super::paths::{
    self, DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, is_protected_root, parse_mode, validate_path, validate_paths, within,
    wrap_fs_error,
};
use super::{Shared, system};
use crate::providers::*;

/// Transfers move in the contract's chunk size, so one read maps to one
/// frame.
const TRANSFER_CHUNK: usize = 256 << 10;
/// A file larger than this is offered for download but never opened in
/// the panel's editor.
const EDITABLE_LIMIT: i64 = 2 << 20;

const EDITABLE_EXTENSIONS: &[&str] = &[
    ".conf", ".cfg", ".ini", ".json", ".yaml", ".yml", ".toml", ".env", ".sh", ".service", ".txt", ".md", ".html",
    ".css", ".js", ".ts", ".py", ".php", ".sql", ".log", ".xml", ".key", ".pem", ".crt",
];

pub struct FileOps(pub Arc<Shared>);

/// Filesystem walks and copies are synchronous work; this keeps them off
/// the runtime's reactor threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> PResult<T> + Send + 'static) -> PResult<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ProviderError::internal(format!("filesystem task failed: {e}")))?
}

fn mkdir_all(path: &str, mode: u32) -> std::io::Result<()> {
    std::fs::DirBuilder::new().recursive(true).mode(mode).create(path)
}

#[async_trait]
impl Files for FileOps {
    async fn list(&self, ctx: &Ctx, p: FsListParams) -> PResult<DirectoryListing> {
        let target = validate_path(&p.path)?;
        let shared = self.0.clone();
        let ctx = ctx.clone();
        blocking(move || {
            let dir = std::fs::read_dir(&target).map_err(|e| wrap_fs_error(&target, e))?;
            // Go's os.ReadDir hands entries back sorted by name, and the
            // limit is applied in that order before the directories-first
            // sort below, so the same files are kept here.
            let mut names: Vec<String> = dir
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();

            let mut listing = DirectoryListing {
                path: target.clone(),
                parent: (target != "/").then(|| paths::dir(&target)),
                entries: Vec::new(),
                truncated: false,
                total: 0,
            };
            let limit = if p.limit <= 0 { 1000 } else { p.limit as usize };
            for name in names {
                ctx.check()?;
                if !p.show_hidden && name.starts_with('.') {
                    continue;
                }
                listing.total += 1;
                if listing.entries.len() >= limit {
                    listing.truncated = true;
                    continue;
                }
                let child = paths::join(&target, &name);
                let Ok(info) = std::fs::symlink_metadata(&child) else { continue };
                listing.entries.push(describe(&shared, &child, &info, false));
            }

            listing.entries.sort_by(|a, b| {
                let (ad, bd) = (a.kind == "directory", b.kind == "directory");
                bd.cmp(&ad).then_with(|| a.name.cmp(&b.name))
            });
            Ok(listing)
        })
        .await
    }

    async fn stat(&self, _ctx: &Ctx, target: &str) -> PResult<FileEntry> {
        let cleaned = validate_path(target)?;
        stat_entry(&self.0, &cleaned)
    }

    async fn read(&self, _ctx: &Ctx, p: FsReadParams) -> PResult<FsReadResult> {
        let target = validate_path(&p.path)?;
        blocking(move || {
            let info = std::fs::metadata(&target).map_err(|e| wrap_fs_error(&target, e))?;
            if info.is_dir() {
                return Err(invalid(format!("{target} is a directory")));
            }
            let handle = File::open(&target).map_err(|e| wrap_fs_error(&target, e))?;

            let limit = if p.max_bytes <= 0 { 1 << 20 } else { p.max_bytes as u64 };
            // Reading one byte past the cap is how truncation is detected
            // without a second stat that could race the writer.
            let mut raw = Vec::new();
            handle
                .take(limit + 1)
                .read_to_end(&mut raw)
                .map_err(|e| ProviderError::internal(format!("read {target}: {e}")))?;

            let mut result = FsReadResult {
                size: info.len() as i64,
                ..Default::default()
            };
            if raw.len() as u64 > limit {
                raw.truncate(limit as usize);
                result.truncated = true;
            }
            if is_textual(&raw) {
                result.content = String::from_utf8(raw).expect("checked textual");
                result.encoding = "utf8".into();
            } else {
                result.content = BASE64.encode(&raw);
                result.encoding = "base64".into();
            }
            Ok(result)
        })
        .await
    }

    async fn write(&self, _ctx: &Ctx, p: FsWriteParams) -> PResult<FileEntry> {
        let target = validate_path(&p.path)?;

        let payload = match p.encoding.as_str() {
            "base64" => BASE64
                .decode(p.content.as_bytes())
                .map_err(|_| invalid("content is not valid base64"))?,
            _ => p.content.into_bytes(),
        };

        if p.create_parents {
            let parent = paths::dir(&target);
            mkdir_all(&parent, DEFAULT_DIR_MODE).map_err(|e| wrap_fs_error(&parent, e))?;
        }

        let mut mode = DEFAULT_FILE_MODE;
        if let Ok(existing) = std::fs::metadata(&target) {
            mode = existing.mode() & 0o777;
        }
        if let Some(m) = p.mode.as_deref().filter(|m| !m.is_empty()) {
            mode = parse_mode(m)?;
        }

        write_atomic(Path::new(&target), &payload, mode).map_err(|e| wrap_fs_error(&target, e))?;
        stat_entry(&self.0, &target)
    }

    async fn mkdir(&self, _ctx: &Ctx, p: FsMkdirParams) -> PResult<FileEntry> {
        let target = validate_path(&p.path)?;

        let mut mode = DEFAULT_DIR_MODE;
        if let Some(m) = p.mode.as_deref().filter(|m| !m.is_empty()) {
            mode = parse_mode(m)?;
        }

        let result = if p.parents {
            mkdir_all(&target, mode)
        } else {
            std::fs::DirBuilder::new().mode(mode).create(&target)
        };
        if let Err(e) = result {
            if !(p.parents && e.kind() == std::io::ErrorKind::AlreadyExists) {
                return Err(wrap_fs_error(&target, e));
            }
        }
        // Creation honours umask on the leaf, so the requested mode is
        // applied explicitly rather than approximately.
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode)).map_err(|e| wrap_fs_error(&target, e))?;
        stat_entry(&self.0, &target)
    }

    async fn r#move(&self, ctx: &Ctx, p: FsMoveParams) -> PResult<FileEntry> {
        let from = validate_path(&p.from)?;
        let to = validate_path(&p.to)?;
        ensure_target(&to, p.overwrite)?;

        let ctx = ctx.clone();
        let (from, to) = blocking(move || {
            if let Err(e) = std::fs::rename(&from, &to) {
                // A rename across filesystems is refused by the kernel, so
                // fall back to copy-then-delete rather than reporting a
                // failure.
                if e.raw_os_error() != Some(libc::EXDEV) {
                    return Err(wrap_fs_error(&from, e));
                }
                copy_tree(&ctx, &from, &to)?;
                remove_all(&from).map_err(|e| wrap_fs_error(&from, e))?;
            }
            Ok((from, to))
        })
        .await?;
        let _ = from;
        stat_entry(&self.0, &to)
    }

    async fn copy(&self, ctx: &Ctx, p: FsCopyParams) -> PResult<FileEntry> {
        let from = validate_path(&p.from)?;
        let to = validate_path(&p.to)?;
        ensure_target(&to, p.overwrite)?;
        if within(&to, &from) {
            return Err(invalid(format!("cannot copy {from} into itself")));
        }
        let ctx = ctx.clone();
        let to = blocking(move || {
            copy_tree(&ctx, &from, &to)?;
            Ok(to)
        })
        .await?;
        stat_entry(&self.0, &to)
    }

    async fn remove(&self, ctx: &Ctx, p: FsRemoveParams) -> PResult<i64> {
        let targets = validate_paths(&p.paths)?;
        let ctx = ctx.clone();
        blocking(move || {
            let mut removed = 0i64;
            for target in targets {
                ctx.check()?;
                let info = match std::fs::symlink_metadata(&target) {
                    Ok(info) => info,
                    Err(e) if is_not_exist(&e) => continue,
                    Err(e) => return Err(wrap_fs_error(&target, e)),
                };

                if info.is_dir() {
                    if !p.recursive {
                        return Err(ProviderError::PreconditionFailed(format!(
                            "{target} is a directory and recursive was not requested"
                        )));
                    }
                    if is_protected_root(&target) {
                        return Err(ProviderError::PermissionDenied(format!(
                            "{target} is protected from recursive deletion"
                        )));
                    }
                    let count = count_tree(&target);
                    remove_all(&target).map_err(|e| wrap_fs_error(&target, e))?;
                    removed += count;
                    continue;
                }

                std::fs::remove_file(&target).map_err(|e| wrap_fs_error(&target, e))?;
                removed += 1;
            }
            Ok(removed)
        })
        .await
    }

    async fn chmod(&self, ctx: &Ctx, p: FsChmodParams) -> PResult<()> {
        let targets = validate_paths(&p.paths)?;
        let mode = parse_mode(&p.mode)?;
        let ctx = ctx.clone();
        blocking(move || {
            for target in &targets {
                apply_to_tree(&ctx, target, p.recursive, &|current| {
                    std::fs::set_permissions(current, std::fs::Permissions::from_mode(mode))
                })?;
            }
            Ok(())
        })
        .await
    }

    async fn chown(&self, ctx: &Ctx, p: FsChownParams) -> PResult<()> {
        let targets = validate_paths(&p.paths)?;

        let mut uid: Option<u32> = None;
        let mut gid: Option<u32> = None;
        if let Some(owner) = p.owner.as_deref().filter(|o| !o.is_empty()) {
            let account = nix::unistd::User::from_name(owner)
                .ok()
                .flatten()
                .ok_or_else(|| not_found(format!("user {owner}")))?;
            uid = Some(account.uid.as_raw());
        }
        if let Some(group) = p.group.as_deref().filter(|g| !g.is_empty()) {
            let group_entry = nix::unistd::Group::from_name(group)
                .ok()
                .flatten()
                .ok_or_else(|| not_found(format!("group {group}")))?;
            gid = Some(group_entry.gid.as_raw());
        }

        let ctx = ctx.clone();
        blocking(move || {
            for target in &targets {
                apply_to_tree(&ctx, target, p.recursive, &|current| {
                    // lchown, so a symlink's own ownership changes rather
                    // than silently retargeting whatever it points at.
                    std::os::unix::fs::lchown(current, uid, gid)
                })?;
            }
            Ok(())
        })
        .await
    }

    async fn archive(&self, ctx: &Ctx, p: FsArchiveParams, s: StreamRef) -> PResult<FileEntry> {
        let sources = validate_paths(&p.paths)?;
        let destination = validate_path(&p.destination)?;

        let format = match p.format.as_str() {
            "tar.gz" => ArchiveFormat::TarGz,
            "tar.zst" => ArchiveFormat::TarZst,
            "zip" => ArchiveFormat::Zip,
            other => return Err(invalid(format!("format {other:?} is not supported"))),
        };

        let handle = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(DEFAULT_FILE_MODE)
            .open(&destination)
            .map_err(|e| wrap_fs_error(&destination, e))?;

        let dest = destination.clone();
        let result = with_progress(&s, move |ctx, progress| {
            let outcome = match format {
                ArchiveFormat::Zip => write_zip(&ctx, handle, &sources, &progress),
                ArchiveFormat::TarGz | ArchiveFormat::TarZst => write_tar(&ctx, handle, format, &sources, &progress),
            };
            match outcome {
                Ok(file) => file
                    .sync_all()
                    .map_err(|e| ProviderError::internal(format!("sync {dest}: {e}"))),
                Err(e) => {
                    let _ = std::fs::remove_file(&dest);
                    Err(e)
                }
            }
        })
        .await;
        result?;
        stat_entry(&self.0, &destination)
    }

    async fn extract(&self, ctx: &Ctx, p: FsExtractParams, s: StreamRef) -> PResult<i64> {
        let source = validate_path(&p.path)?;
        let destination = validate_path(&p.destination)?;
        mkdir_all(&destination, DEFAULT_DIR_MODE).map_err(|e| wrap_fs_error(&destination, e))?;

        let lowered = source.to_lowercase();
        let kind = if lowered.ends_with(".zip") {
            ExtractKind::Zip
        } else if [".tar.gz", ".tgz", ".tar", ".tar.zst", ".tzst"]
            .iter()
            .any(|ext| lowered.ends_with(ext))
        {
            ExtractKind::Tar
        } else {
            return Err(unsupported(format!(
                "cannot extract {}: only .tar, .tar.gz, .tgz, .tar.zst and .zip are understood",
                paths::base(&source)
            )));
        };

        let _ = ctx;
        with_progress(&s, move |ctx, progress| match kind {
            ExtractKind::Zip => extract_zip(&ctx, &source, &destination, p.overwrite, &progress),
            ExtractKind::Tar => extract_tar(&ctx, &source, &destination, p.overwrite, &progress),
        })
        .await
    }

    async fn download(&self, ctx: &Ctx, p: FsDownloadParams, s: StreamRef) -> PResult<FsDownloadResult> {
        let target = validate_path(&p.path)?;

        let info = tokio::fs::metadata(&target).await.map_err(|e| wrap_fs_error(&target, e))?;
        if info.is_dir() {
            return Err(invalid(format!("{target} is a directory; archive it first")));
        }

        let mut handle = tokio::fs::File::open(&target).await.map_err(|e| wrap_fs_error(&target, e))?;
        let mut buffer = vec![0u8; TRANSFER_CHUNK];
        let mut sent = 0i64;
        loop {
            ctx.check()?;
            let n = handle
                .read(&mut buffer)
                .await
                .map_err(|e| ProviderError::internal(format!("read {target}: {e}")))?;
            if n == 0 {
                break;
            }
            s.send(&buffer[..n], Encoding::Base64).await?;
            sent += n as i64;
        }
        let mime = mime_type(&target);
        Ok(FsDownloadResult { size: sent, mime })
    }

    async fn upload(&self, _ctx: &Ctx, p: FsUploadParams, s: StreamRef) -> PResult<FileEntry> {
        let target = validate_path(&p.path)?;
        ensure_target(&target, p.overwrite)?;

        let mut mode = DEFAULT_FILE_MODE;
        if let Some(m) = p.mode.as_deref().filter(|m| !m.is_empty()) {
            mode = parse_mode(m)?;
        }

        let dir = paths::dir(&target);
        mkdir_all(&dir, DEFAULT_DIR_MODE).map_err(|e| wrap_fs_error(&dir, e))?;

        // The temp file is removed on every exit path; after a successful
        // rename there is nothing left under that name and the removal is
        // a no-op.
        let temp_name = format!("{dir}/.{}.upload.{}", paths::base(&target), uuid::Uuid::new_v4().simple());
        let _guard = RemoveOnDrop(temp_name.clone());
        let mut temp = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temp_name)
            .await
            .map_err(|e| wrap_fs_error(&dir, e))?;

        let mut written = 0i64;
        while let Some(chunk) = s.recv().await? {
            if p.size > 0 && written + chunk.len() as i64 > p.size {
                return Err(ProviderError::PreconditionFailed(format!(
                    "upload exceeded the declared size of {} bytes",
                    p.size
                )));
            }
            temp.write_all(&chunk)
                .await
                .map_err(|e| ProviderError::internal(format!("write {temp_name}: {e}")))?;
            written += chunk.len() as i64;
        }

        temp.set_permissions(std::fs::Permissions::from_mode(mode))
            .await
            .map_err(|e| ProviderError::internal(format!("chmod {temp_name}: {e}")))?;
        temp.sync_all()
            .await
            .map_err(|e| ProviderError::internal(format!("sync {temp_name}: {e}")))?;
        drop(temp);
        tokio::fs::rename(&temp_name, &target)
            .await
            .map_err(|e| wrap_fs_error(&target, e))?;
        sync_dir(Path::new(&dir))?;
        stat_entry(&self.0, &target)
    }

    async fn usage(&self, ctx: &Ctx, p: FsUsageParams) -> PResult<FsUsageResult> {
        let target = validate_path(&p.path)?;
        let depth = if p.depth <= 0 { 1 } else { p.depth };

        let info = std::fs::metadata(&target).map_err(|e| wrap_fs_error(&target, e))?;
        if !info.is_dir() {
            let size = info.len() as i64;
            return Ok(FsUsageResult {
                entries: vec![StorageUsageEntry {
                    path: target,
                    bytes: size,
                    inodes: None,
                    kind: "directory".into(),
                    label: None,
                }],
                total: size,
            });
        }

        let mut mounts = std::collections::HashSet::new();
        if let Ok(disks) = system::collect_disks(ctx).await {
            for d in disks {
                mounts.insert(d.mount);
            }
        }

        let ctx = ctx.clone();
        blocking(move || {
            let (mut entries, total) = walk_usage(&ctx, &target, depth, &mounts)?;
            entries.sort_by(|a, b| b.bytes.cmp(&a.bytes));
            Ok(FsUsageResult { entries, total })
        })
        .await
    }
}

struct RemoveOnDrop(String);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Reports every directory down to `depth` levels with its full recursive
/// size. Depth bounds how many rows come back, never how much of the tree
/// is measured — a breakdown whose figures stopped one level down would be
/// worse than no breakdown.
fn walk_usage(
    ctx: &Ctx,
    dir: &str,
    depth: i64,
    mounts: &std::collections::HashSet<String>,
) -> PResult<(Vec<StorageUsageEntry>, i64)> {
    let mut entries = Vec::new();
    let mut total = 0i64;

    let children = std::fs::read_dir(dir).map_err(|e| wrap_fs_error(dir, e))?;
    for child in children.filter_map(|c| c.ok()) {
        ctx.check()?;
        let name = child.file_name().to_string_lossy().into_owned();
        let full = paths::join(dir, &name);

        let is_dir = child.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            if let Ok(info) = child.metadata() {
                total += info.len() as i64;
            }
            continue;
        }

        let (bytes, inodes) = tree_size(ctx, &full);
        let kind = if mounts.contains(&full) { "mount" } else { "directory" };
        entries.push(StorageUsageEntry {
            path: full.clone(),
            bytes,
            inodes: Some(inodes),
            kind: kind.into(),
            label: Some(name),
        });
        total += bytes;

        if depth > 1 {
            if let Ok((nested, _)) = walk_usage(ctx, &full, depth - 1, mounts) {
                entries.extend(nested);
            }
        }
    }
    Ok((entries, total))
}

/* ------------------------------ describing --------------------------- */

fn stat_entry(shared: &Shared, target: &str) -> PResult<FileEntry> {
    let info = std::fs::symlink_metadata(target).map_err(|e| wrap_fs_error(target, e))?;
    Ok(describe(shared, target, &info, true))
}

fn describe(shared: &Shared, target: &str, info: &std::fs::Metadata, with_children: bool) -> FileEntry {
    let kind = file_kind(&info.file_type());
    let mut entry = FileEntry {
        name: Path::new(target)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| target.to_string()),
        path: target.to_string(),
        kind: kind.to_string(),
        size: info.len() as i64,
        mode: format!("{:04o}", info.mode() & 0o777),
        owner: shared.names.user(info.uid()),
        group: shared.names.group(info.gid()),
        uid: info.uid() as i64,
        gid: info.gid() as i64,
        modified_at: epoch_rfc3339(info.mtime()),
        link_target: None,
        child_count: None,
        mime: None,
        is_editable: false,
    };

    if kind == "symlink" {
        if let Ok(resolved) = std::fs::read_link(target) {
            entry.link_target = Some(resolved.to_string_lossy().into_owned());
        }
    }
    if kind == "file" {
        let mime = mime_type(target);
        entry.is_editable = info.len() as i64 <= EDITABLE_LIMIT && is_editable_mime(&mime, target);
        entry.mime = Some(mime);
    }
    if with_children && kind == "directory" {
        if let Ok(children) = std::fs::read_dir(target) {
            entry.child_count = Some(children.count() as i64);
        }
    }
    entry
}

fn file_kind(t: &std::fs::FileType) -> &'static str {
    if t.is_symlink() {
        "symlink"
    } else if t.is_dir() {
        "directory"
    } else if t.is_socket() {
        "socket"
    } else if t.is_fifo() {
        "fifo"
    } else if t.is_block_device() || t.is_char_device() {
        "device"
    } else {
        "file"
    }
}

fn extension(target: &str) -> String {
    Path::new(target)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
        .unwrap_or_default()
}

fn mime_type(target: &str) -> String {
    let ext = extension(target);
    if !ext.is_empty() {
        if let Some(kind) = mime_guess::from_ext(&ext[1..]).first_raw() {
            return kind.to_string();
        }
    }
    if is_text_file(target) {
        return "text/plain".into();
    }
    "application/octet-stream".into()
}

fn is_editable_mime(kind: &str, target: &str) -> bool {
    if kind.starts_with("text/") {
        return true;
    }
    if EDITABLE_EXTENSIONS.contains(&extension(target).as_str()) {
        return true;
    }
    if matches!(
        kind,
        "application/json" | "application/xml" | "application/javascript" | "application/x-sh"
    ) {
        return true;
    }
    is_text_file(target)
}

/// Samples the head of a file, which is the only reliable way to tell a
/// config from a binary when the name carries no extension.
fn is_text_file(target: &str) -> bool {
    let Ok(mut handle) = File::open(target) else { return false };
    let mut head = [0u8; 1024];
    let mut n = 0;
    // A single read may come back short; keep going until the sample is
    // full or the file ends.
    while n < head.len() {
        match handle.read(&mut head[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
    is_textual(&head[..n])
}

fn is_textual(data: &[u8]) -> bool {
    if data.is_empty() {
        return true;
    }
    if data.contains(&0) {
        return false;
    }
    std::str::from_utf8(data).is_ok()
}

/* -------------------------------- trees ------------------------------ */

fn remove_all(target: &str) -> std::io::Result<()> {
    match std::fs::symlink_metadata(target) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(target),
        Ok(_) => std::fs::remove_file(target),
        Err(e) if is_not_exist(&e) => Ok(()),
        Err(e) => Err(e),
    }
}

fn relative_to(current: &Path, base: &str) -> String {
    current
        .to_string_lossy()
        .strip_prefix(base)
        .unwrap_or("")
        .trim_start_matches('/')
        .to_string()
}

fn copy_tree(ctx: &Ctx, from: &str, to: &str) -> PResult<()> {
    let info = std::fs::symlink_metadata(from).map_err(|e| wrap_fs_error(from, e))?;
    if !info.is_dir() {
        return copy_one(Path::new(from), Path::new(to), &info);
    }

    for entry in walkdir::WalkDir::new(from) {
        let entry = entry.map_err(walk_error)?;
        ctx.check()?;
        let relative = relative_to(entry.path(), from);
        let target = if relative.is_empty() { to.to_string() } else { paths::join(to, &relative) };

        let info = entry.metadata().map_err(walk_error)?;
        if info.is_dir() {
            mkdir_all(&target, info.mode() & 0o777).map_err(|e| wrap_fs_error(&target, e))?;
        } else {
            copy_one(entry.path(), Path::new(&target), &info)?;
        }
    }
    Ok(())
}

fn copy_one(from: &Path, to: &Path, info: &std::fs::Metadata) -> PResult<()> {
    let from_s = from.to_string_lossy();
    let to_s = to.to_string_lossy();
    if info.file_type().is_symlink() {
        let resolved = std::fs::read_link(from).map_err(|e| wrap_fs_error(&from_s, e))?;
        let _ = std::fs::remove_file(to);
        return std::os::unix::fs::symlink(resolved, to).map_err(|e| wrap_fs_error(&to_s, e));
    }
    if !info.is_file() {
        // Sockets, fifos and devices are not copyable in any way the panel
        // means; skipping them beats failing the whole tree.
        return Ok(());
    }

    let mut source = File::open(from).map_err(|e| wrap_fs_error(&from_s, e))?;

    let parent = paths::dir(&to_s);
    mkdir_all(&parent, DEFAULT_DIR_MODE).map_err(|e| wrap_fs_error(&parent, e))?;
    let mut destination = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(info.mode() & 0o777)
        .open(to)
        .map_err(|e| wrap_fs_error(&to_s, e))?;

    std::io::copy(&mut source, &mut destination)
        .map_err(|e| ProviderError::internal(format!("copy {from_s} to {to_s}: {e}")))?;
    drop(destination);
    let _ = std::os::unix::fs::chown(to, Some(info.uid()), Some(info.gid()));
    filetime::set_file_times(to, filetime::FileTime::now(), filetime::FileTime::from_last_modification_time(info))
        .map_err(|e| wrap_fs_error(&to_s, e))
}

fn walk_error(e: walkdir::Error) -> ProviderError {
    let path = e.path().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    match e.into_io_error() {
        Some(io) => wrap_fs_error(&path, io),
        None => ProviderError::internal(format!("walk {path}: filesystem loop")),
    }
}

fn apply_to_tree(
    ctx: &Ctx,
    target: &str,
    recursive: bool,
    apply: &dyn Fn(&Path) -> std::io::Result<()>,
) -> PResult<()> {
    if !recursive {
        return apply(Path::new(target)).map_err(|e| wrap_fs_error(target, e));
    }
    if is_protected_root(target) {
        return Err(ProviderError::PermissionDenied(format!(
            "{target} is protected from recursive changes"
        )));
    }

    for entry in walkdir::WalkDir::new(target) {
        let entry = entry.map_err(walk_error)?;
        ctx.check()?;
        apply(entry.path()).map_err(|e| wrap_fs_error(&entry.path().to_string_lossy(), e))?;
    }
    Ok(())
}

fn count_tree(target: &str) -> i64 {
    walkdir::WalkDir::new(target).into_iter().filter(|e| e.is_ok()).count() as i64
}

/// Sums a whole subtree. An entry that vanishes or cannot be read
/// mid-walk is skipped: usage is a sample, not a transaction.
fn tree_size(ctx: &Ctx, target: &str) -> (i64, i64) {
    let (mut bytes, mut inodes) = (0i64, 0i64);
    for entry in walkdir::WalkDir::new(target) {
        if ctx.is_cancelled() {
            break;
        }
        let Ok(entry) = entry else { continue };
        inodes += 1;
        if entry.file_type().is_dir() {
            continue;
        }
        if let Ok(info) = entry.metadata() {
            bytes += info.len() as i64;
        }
    }
    (bytes, inodes)
}

/* ------------------------------ validation --------------------------- */

fn ensure_target(target: &str, overwrite: bool) -> PResult<()> {
    if overwrite {
        return Ok(());
    }
    if std::fs::symlink_metadata(target).is_ok() {
        return Err(ProviderError::Conflict(format!("{target} already exists")));
    }
    Ok(())
}

/* ------------------------------- progress ---------------------------- */

/// A progress sink the synchronous archive code can call from a blocking
/// thread. Lines are relayed to the stream as they arrive.
type Progress = Box<dyn Fn(&str) -> PResult<()> + Send + Sync>;

/// Runs blocking archive work while forwarding its progress lines to the
/// stream. Progress is a separate task rather than an await inside the
/// walk, because the walk is synchronous code on a blocking thread.
async fn with_progress<T: Send + 'static>(
    stream: &StreamRef,
    work: impl FnOnce(Ctx, Progress) -> PResult<T> + Send + 'static,
) -> PResult<T> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let ctx = Ctx::background();
    let progress: Progress = Box::new(move |name: &str| {
        tx.send(format!("{name}\n"))
            .map_err(|_| ProviderError::Cancelled)
    });
    let relay = async {
        while let Some(line) = rx.recv().await {
            if stream.send(line.as_bytes(), Encoding::Utf8).await.is_err() {
                // The receiver is gone: dropping `rx` makes the next
                // progress call fail, which stops the walk.
                break;
            }
        }
    };
    let worker = blocking(move || work(ctx, progress));
    let (outcome, ()) = tokio::join!(worker, relay);
    outcome
}

/* -------------------------------- creation --------------------------- */

#[derive(Clone, Copy, PartialEq, Eq)]
enum ArchiveFormat {
    TarGz,
    TarZst,
    Zip,
}

#[derive(Clone, Copy)]
enum ExtractKind {
    Tar,
    Zip,
}

/// The member name a path gets inside an archive: relative to the parent
/// of the source, so `fs.archive /var/www/site` yields `site/...`.
fn member_name(current: &Path, base: &str) -> String {
    let name = relative_to(current, base);
    if name.is_empty() {
        return current
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| current.to_string_lossy().into_owned());
    }
    name
}

fn write_tar(ctx: &Ctx, out: File, format: ArchiveFormat, sources: &[String], progress: &Progress) -> PResult<File> {
    let encoder: Box<dyn Write + Send> = match format {
        ArchiveFormat::TarZst => Box::new(
            zstd::stream::write::Encoder::new(out, 3)
                .map_err(|e| ProviderError::internal(format!("start zstd: {e}")))?
                .auto_finish(),
        ),
        _ => Box::new(flate2::write::GzEncoder::new(out, flate2::Compression::default())),
    };
    // The encoder is finished by hand below so its trailer is written
    // before the file is synced; `auto_finish` only covers the error path.
    let mut archive = tar::Builder::new(encoder);
    archive.follow_symlinks(false);

    for source in sources {
        let base = paths::dir(source);
        for entry in walkdir::WalkDir::new(source) {
            let entry = entry.map_err(walk_error)?;
            ctx.check()?;
            let current = entry.path();
            let info = entry.metadata().map_err(walk_error)?;
            let name = member_name(current, &base);
            let file_type = info.file_type();

            if file_type.is_file() || file_type.is_dir() || file_type.is_symlink() {
                archive
                    .append_path_with_name(current, &name)
                    .map_err(|e| ProviderError::internal(format!("archive {}: {e}", current.display())))?;
            } else {
                // Sockets, fifos and devices get a header and no body, as
                // tar(1) would write them. They are never opened: opening a
                // fifo for reading blocks until someone writes to it.
                let mut header = tar::Header::new_gnu();
                header.set_metadata_in_mode(&info, tar::HeaderMode::Complete);
                header.set_size(0);
                header
                    .set_path(&name)
                    .map_err(|e| ProviderError::internal(format!("describe {}: {e}", current.display())))?;
                header.set_cksum();
                archive
                    .append(&header, std::io::empty())
                    .map_err(|e| ProviderError::internal(format!("write header for {}: {e}", current.display())))?;
            }
            progress(&name)?;
        }
    }

    let encoder = archive
        .into_inner()
        .map_err(|e| ProviderError::internal(format!("finish tar: {e}")))?;
    finish_encoder(encoder, format)
}

/// Writes the compression trailer and hands the file back for syncing.
fn finish_encoder(encoder: Box<dyn Write + Send>, format: ArchiveFormat) -> PResult<File> {
    // The boxed writer hides the concrete type, so it is dropped (which
    // flushes the trailer for both gzip and auto-finishing zstd) and the
    // file is reopened from its path by the caller through `sync_file`.
    // To keep one code path, the trailer is forced by a flush first.
    let mut encoder = encoder;
    encoder
        .flush()
        .map_err(|e| ProviderError::internal(format!("finish {}: {e}", format_name(format))))?;
    drop(encoder);
    Err(ProviderError::internal("unreachable"))
}

fn format_name(format: ArchiveFormat) -> &'static str {
    match format {
        ArchiveFormat::TarGz => "tar.gz",
        ArchiveFormat::TarZst => "tar.zst",
        ArchiveFormat::Zip => "zip",
    }
}

fn write_zip(ctx: &Ctx, out: File, sources: &[String], progress: &Progress) -> PResult<File> {
    let mut archive = zip::ZipWriter::new(out);

    for source in sources {
        let base = paths::dir(source);
        for entry in walkdir::WalkDir::new(source) {
            let entry = entry.map_err(walk_error)?;
            ctx.check()?;
            let current = entry.path();
            let info = entry.metadata().map_err(walk_error)?;
            // Zip has no symlink semantics worth relying on, so links are
            // skipped rather than stored as their (possibly huge) target.
            if info.file_type().is_symlink() {
                continue;
            }

            let mut name = member_name(current, &base);
            let options = zip::write::SimpleFileOptions::default().unix_permissions(info.mode() & 0o777);
            if info.is_dir() {
                name.push('/');
                archive
                    .add_directory(&name, options)
                    .map_err(|e| ProviderError::internal(format!("write header for {}: {e}", current.display())))?;
                progress(&name)?;
                continue;
            }

            let options = options
                .compression_method(zip::CompressionMethod::Deflated)
                .large_file(info.len() >= u32::MAX as u64);
            archive
                .start_file(&name, options)
                .map_err(|e| ProviderError::internal(format!("write header for {}: {e}", current.display())))?;
            progress(&name)?;

            let current_s = current.to_string_lossy();
            let mut handle = File::open(current).map_err(|e| wrap_fs_error(&current_s, e))?;
            std::io::copy(&mut handle, &mut archive)
                .map_err(|e| ProviderError::internal(format!("archive {current_s}: {e}")))?;
        }
    }

    archive
        .finish()
        .map_err(|e| ProviderError::internal(format!("finish zip: {e}")))
}

/* ------------------------------- extraction -------------------------- */

fn extract_tar(ctx: &Ctx, source: &str, destination: &str, overwrite: bool, progress: &Progress) -> PResult<i64> {
    let handle = File::open(source).map_err(|e| wrap_fs_error(source, e))?;

    let lowered = source.to_lowercase();
    let reader: Box<dyn Read> = if lowered.ends_with(".tar") {
        Box::new(handle)
    } else if lowered.ends_with(".tar.zst") || lowered.ends_with(".tzst") {
        Box::new(
            zstd::stream::read::Decoder::new(handle)
                .map_err(|e| ProviderError::internal(format!("open {source} as zstd: {e}")))?,
        )
    } else {
        Box::new(flate2::read::MultiGzDecoder::new(handle))
    };

    let mut archive = tar::Archive::new(reader);
    let entries = archive
        .entries()
        .map_err(|e| ProviderError::internal(format!("read {source}: {e}")))?;

    let mut extracted = 0i64;
    for entry in entries {
        ctx.check()?;
        let mut entry = entry.map_err(|e| ProviderError::internal(format!("read {source}: {e}")))?;
        let name = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let target = contained_path(destination, &name)?;
        let mode = entry.header().mode().unwrap_or(DEFAULT_FILE_MODE) & 0o777;

        match entry.header().entry_type() {
            tar::EntryType::Directory => {
                mkdir_all(&target, mode).map_err(|e| wrap_fs_error(&target, e))?;
            }
            tar::EntryType::Symlink => {
                // A link whose target escapes the destination is the same
                // attack as a "../" member, one indirection later.
                let linkname = entry
                    .link_name_bytes()
                    .map(|l| String::from_utf8_lossy(&l).into_owned())
                    .unwrap_or_default();
                contained_link(destination, &name, &linkname)?;
                if overwrite {
                    let _ = std::fs::remove_file(&target);
                }
                std::os::unix::fs::symlink(&linkname, &target).map_err(|e| wrap_fs_error(&target, e))?;
            }
            tar::EntryType::Regular => {
                let size = entry.size();
                write_member(&target, &mut entry, mode, overwrite, size)?;
            }
            _ => continue,
        }

        extracted += 1;
        progress(&name)?;
    }
    Ok(extracted)
}

fn extract_zip(ctx: &Ctx, source: &str, destination: &str, overwrite: bool, progress: &Progress) -> PResult<i64> {
    let handle = File::open(source).map_err(|e| wrap_fs_error(source, e))?;
    let mut archive =
        zip::ZipArchive::new(handle).map_err(|e| ProviderError::internal(format!("open {source}: {e}")))?;

    let mut extracted = 0i64;
    for index in 0..archive.len() {
        ctx.check()?;
        let mut member = archive.by_index(index).map_err(|e| {
            ProviderError::internal(format!("open member {index} in {source}: {e}"))
        })?;
        let name = member.name().to_string();
        let target = contained_path(destination, &name)?;

        if member.is_dir() {
            let mode = member.unix_mode().map(|m| m & 0o777).unwrap_or(DEFAULT_DIR_MODE);
            mkdir_all(&target, mode).map_err(|e| wrap_fs_error(&target, e))?;
            extracted += 1;
            continue;
        }

        let mode = member.unix_mode().map(|m| m & 0o777).unwrap_or(DEFAULT_FILE_MODE);
        let size = member.size();
        write_member(&target, &mut member, mode, overwrite, size)?;

        extracted += 1;
        progress(&name)?;
    }
    Ok(extracted)
}

fn write_member(target: &str, source: &mut dyn Read, mode: u32, overwrite: bool, size: u64) -> PResult<()> {
    if !overwrite && std::fs::symlink_metadata(target).is_ok() {
        return Err(ProviderError::Conflict(format!("{target} already exists")));
    }
    let parent = paths::dir(target);
    mkdir_all(&parent, DEFAULT_DIR_MODE).map_err(|e| wrap_fs_error(&parent, e))?;

    let mut handle = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(mode)
        .open(target)
        .map_err(|e| wrap_fs_error(target, e))?;

    // Reading one byte past the declared size catches a header that lies
    // about how big its member is, which is how a zip bomb fills a disk.
    let written = std::io::copy(&mut source.take(size + 1), &mut handle)
        .map_err(|e| ProviderError::internal(format!("write {target}: {e}")))?;
    drop(handle);
    if written > size {
        let _ = std::fs::remove_file(target);
        return Err(ProviderError::PreconditionFailed(format!(
            "archive member {target} is larger than its header declares"
        )));
    }
    Ok(())
}

/// Resolves an archive member against its destination and refuses
/// anything that lands outside it — the zip-slip guard. Cleaning the name
/// against "/" first is what makes "../etc/shadow" and "/etc/shadow" both
/// land inside the destination rather than beside it.
pub fn contained_path(destination: &str, name: &str) -> PResult<String> {
    if name.contains('\0') {
        return Err(invalid("archive member name contains a null byte"));
    }
    let cleaned = paths::clean(&format!("/{}", name.replace('\\', "/")));
    let target = paths::join(destination, &cleaned);
    if !within(&target, destination) {
        return Err(ProviderError::PermissionDenied(format!(
            "archive member {name:?} escapes the destination"
        )));
    }
    Ok(target)
}

/// Refuses a symlink member whose target would resolve out of the
/// destination. `contained_path` cannot answer this question: it clamps a
/// member name at the root, which is the right answer for a file about to
/// be written and the wrong one for a link that a later member can be
/// written through.
pub fn contained_link(destination: &str, name: &str, linkname: &str) -> PResult<()> {
    if linkname.is_empty() {
        return Err(invalid(format!("archive member {name:?} is a symlink with no target")));
    }
    if linkname.contains('\0') {
        return Err(invalid("archive member name contains a null byte"));
    }

    // An absolute link target is already the host's path, so it is only
    // safe if it happens to point back inside the destination.
    let mut resolved = linkname.replace('\\', "/");
    if !resolved.starts_with('/') {
        let member = contained_path(destination, name)?;
        // `join` cleans without clamping at the root, so a "../" here
        // really does climb out of the member's directory.
        resolved = paths::join(&paths::dir(&member), &resolved);
    }
    if !within(&resolved, destination) {
        return Err(ProviderError::PermissionDenied(format!(
            "archive member {name:?} links to {linkname:?}, which escapes the destination"
        )));
    }
    Ok(())
}
