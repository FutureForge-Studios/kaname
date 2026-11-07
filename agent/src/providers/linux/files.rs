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
    self, DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, is_protected_root, parse_mode, validate_path, validate_paths,
    within, wrap_fs_error,
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
    ".conf", ".cfg", ".ini", ".json", ".yaml", ".yml", ".toml", ".env", ".sh", ".service", ".txt", ".md",
    ".html", ".css", ".js", ".ts", ".py", ".php", ".sql", ".log", ".xml", ".key", ".pem", ".crt",
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
                let Ok(info) = std::fs::symlink_metadata(&child) else {
                    continue;
                };
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

            let limit = if p.max_bytes <= 0 {
                1 << 20
            } else {
                p.max_bytes as u64
            };
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
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode))
            .map_err(|e| wrap_fs_error(&target, e))?;
        stat_entry(&self.0, &target)
    }

    async fn r#move(&self, ctx: &Ctx, p: FsMoveParams) -> PResult<FileEntry> {
        let from = validate_path(&p.from)?;
        let to = validate_path(&p.to)?;
        ensure_target(&to, p.overwrite)?;

        let ctx = ctx.clone();
        let to = blocking(move || {
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
            Ok(to)
        })
        .await?;
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
        with_progress(ctx, &s, move |ctx, progress| {
            let outcome = match format {
                ArchiveFormat::Zip => write_zip(&ctx, handle, &sources, &progress),
                ArchiveFormat::TarGz | ArchiveFormat::TarZst => {
                    write_tar(&ctx, handle, format, &sources, &progress)
                }
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
        .await?;
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

        with_progress(ctx, &s, move |ctx, progress| match kind {
            ExtractKind::Zip => extract_zip(&ctx, &source, &destination, p.overwrite, &progress),
            ExtractKind::Tar => extract_tar(&ctx, &source, &destination, p.overwrite, &progress),
        })
        .await
    }

    async fn download(&self, ctx: &Ctx, p: FsDownloadParams, s: StreamRef) -> PResult<FsDownloadResult> {
        let target = validate_path(&p.path)?;

        let info = tokio::fs::metadata(&target)
            .await
            .map_err(|e| wrap_fs_error(&target, e))?;
        if info.is_dir() {
            return Err(invalid(format!("{target} is a directory; archive it first")));
        }

        let mut handle = tokio::fs::File::open(&target)
            .await
            .map_err(|e| wrap_fs_error(&target, e))?;
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
        let temp_name = format!(
            "{dir}/.{}.upload.{}",
            paths::base(&target),
            uuid::Uuid::new_v4().simple()
        );
        let _guard = RemoveOnDrop(temp_name.clone());
        let mut temp = tokio::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temp_name)
            .await
            .map_err(|e| wrap_fs_error(&dir, e))?;

        // The declared size is the end marker: the control plane sends no
        // end-of-input frame for an upload (routes/files.ts), so reading
        // until the stream closed waited for ever on every upload.
        let mut written = 0i64;
        while written < p.size {
            let Some(chunk) = s.recv().await? else { break };
            if written + chunk.len() as i64 > p.size {
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
        if written != p.size {
            return Err(ProviderError::PreconditionFailed(format!(
                "upload ended after {written} of the declared {} bytes",
                p.size
            )));
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
            entries.sort_by_key(|e| std::cmp::Reverse(e.bytes));
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
        let kind = if mounts.contains(&full) {
            "mount"
        } else {
            "directory"
        };
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
    let Ok(mut handle) = File::open(target) else {
        return false;
    };
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
        let target = if relative.is_empty() {
            to.to_string()
        } else {
            paths::join(to, &relative)
        };

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
    filetime::set_file_times(
        to,
        filetime::FileTime::now(),
        filetime::FileTime::from_last_modification_time(info),
    )
    .map_err(|e| wrap_fs_error(&to_s, e))
}

fn walk_error(e: walkdir::Error) -> ProviderError {
    let path = e
        .path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
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
    walkdir::WalkDir::new(target)
        .into_iter()
        .filter(|e| e.is_ok())
        .count() as i64
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
    ctx: &Ctx,
    stream: &StreamRef,
    work: impl FnOnce(Ctx, Progress) -> PResult<T> + Send + 'static,
) -> PResult<T> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let ctx = ctx.clone();
    let progress: Progress =
        Box::new(move |name: &str| tx.send(format!("{name}\n")).map_err(|_| ProviderError::Cancelled));
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

/// Writes a compressed tar and hands the file back, trailer written, for
/// the caller to sync. The compressor is finished by hand rather than on
/// drop so an error in the trailer is reported instead of lost.
fn write_tar(
    ctx: &Ctx,
    out: File,
    format: ArchiveFormat,
    sources: &[String],
    progress: &Progress,
) -> PResult<File> {
    match format {
        ArchiveFormat::TarZst => {
            let encoder = zstd::stream::write::Encoder::new(out, 3)
                .map_err(|e| ProviderError::internal(format!("start zstd: {e}")))?;
            let mut archive = tar::Builder::new(encoder);
            tar_into(ctx, &mut archive, sources, progress)?;
            archive
                .into_inner()
                .and_then(|encoder| encoder.finish())
                .map_err(|e| ProviderError::internal(format!("finish tar.zst: {e}")))
        }
        _ => {
            let encoder = flate2::write::GzEncoder::new(out, flate2::Compression::default());
            let mut archive = tar::Builder::new(encoder);
            tar_into(ctx, &mut archive, sources, progress)?;
            archive
                .into_inner()
                .and_then(|encoder| encoder.finish())
                .map_err(|e| ProviderError::internal(format!("finish tar.gz: {e}")))
        }
    }
}

fn tar_into<W: Write>(
    ctx: &Ctx,
    archive: &mut tar::Builder<W>,
    sources: &[String],
    progress: &Progress,
) -> PResult<()> {
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
                archive.append(&header, std::io::empty()).map_err(|e| {
                    ProviderError::internal(format!("write header for {}: {e}", current.display()))
                })?;
            }
            progress(&name)?;
        }
    }
    Ok(())
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
                archive.add_directory(&name, options).map_err(|e| {
                    ProviderError::internal(format!("write header for {}: {e}", current.display()))
                })?;
                progress(&name)?;
                continue;
            }

            let options = options
                .compression_method(zip::CompressionMethod::Deflated)
                .large_file(info.len() >= u32::MAX as u64);
            archive.start_file(&name, options).map_err(|e| {
                ProviderError::internal(format!("write header for {}: {e}", current.display()))
            })?;
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

fn extract_tar(
    ctx: &Ctx,
    source: &str,
    destination: &str,
    overwrite: bool,
    progress: &Progress,
) -> PResult<i64> {
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

fn extract_zip(
    ctx: &Ctx,
    source: &str,
    destination: &str,
    overwrite: bool,
    progress: &Progress,
) -> PResult<i64> {
    let handle = File::open(source).map_err(|e| wrap_fs_error(source, e))?;
    let mut archive =
        zip::ZipArchive::new(handle).map_err(|e| ProviderError::internal(format!("open {source}: {e}")))?;

    let mut extracted = 0i64;
    for index in 0..archive.len() {
        ctx.check()?;
        let mut member = archive
            .by_index(index)
            .map_err(|e| ProviderError::internal(format!("open member {index} in {source}: {e}")))?;
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
        return Err(invalid(format!(
            "archive member {name:?} is a symlink with no target"
        )));
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

/* --------------------------------- tests ------------------------------ */

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::Write;

    use super::*;

    /* Zip-slip.
     *
     * An archive is attacker-controlled by the time it reaches a host: the
     * operator uploads what a customer sent and asks the panel to unpack
     * it. These tests build the hostile archives for real and assert on
     * the filesystem afterwards, because the only claim worth making is
     * that nothing landed outside the destination. */

    /// The member names every extractor gets caught by. Each one is a real
    /// shape from the zip-slip family.
    const HOSTILE_MEMBERS: &[&str] = &[
        "../escaped.txt",
        "../../escaped.txt",
        "../../../../../../../../etc/cron.d/escaped",
        "/etc/cron.d/absolute",
        "//etc/cron.d/doubled",
        "nested/../../escaped.txt",
        "./../escaped.txt",
        r"..\escaped.txt",
        r"..\..\windows\escaped.txt",
    ];

    struct TarEntry {
        name: &'static str,
        body: &'static str,
        linkname: &'static str,
    }

    fn file(name: &'static str, body: &'static str) -> TarEntry {
        TarEntry {
            name,
            body,
            linkname: "",
        }
    }

    fn link(name: &'static str, linkname: &'static str) -> TarEntry {
        TarEntry {
            name,
            body: "",
            linkname,
        }
    }

    /// Writes a member name byte for byte. The tar crate refuses to spell
    /// `..` through its path setter, which is the right default for a
    /// producer and useless for building the hostile input these tests
    /// need, so the ustar name field is filled directly.
    fn raw_name(header: &mut tar::Header, name: &str) {
        let field = &mut header.as_old_mut().name;
        field.fill(0);
        field[..name.len()].copy_from_slice(name.as_bytes());
    }

    fn build_tar_gz(path: &Path, entries: &[TarEntry]) {
        let handle = File::create(path).unwrap();
        let gz = flate2::write::GzEncoder::new(handle, flate2::Compression::default());
        let mut archive = tar::Builder::new(gz);
        for entry in entries {
            let mut header = tar::Header::new_gnu();
            raw_name(&mut header, entry.name);
            if entry.linkname.is_empty() {
                header.set_mode(0o644);
                header.set_entry_type(tar::EntryType::Regular);
                header.set_size(entry.body.len() as u64);
                header.set_cksum();
                archive.append(&header, entry.body.as_bytes()).unwrap();
            } else {
                header.set_mode(0o777);
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_size(0);
                header.set_link_name_literal(entry.linkname).unwrap();
                header.set_cksum();
                archive.append(&header, std::io::empty()).unwrap();
            }
        }
        archive.into_inner().unwrap().finish().unwrap();
    }

    fn build_zip(path: &Path, entries: &[TarEntry]) {
        let handle = File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(handle);
        for entry in entries {
            archive
                .start_file(entry.name, zip::write::SimpleFileOptions::default())
                .unwrap();
            archive.write_all(entry.body.as_bytes()).unwrap();
        }
        archive.finish().unwrap();
    }

    /// Walks the whole scratch area and fails on any file that is not
    /// under the destination. It is deliberately blunt: it does not care
    /// *how* the extractor handled a hostile member, only that the member
    /// did not end up somewhere it could be executed from.
    fn assert_nothing_outside(root: &Path, destination: &Path) {
        for entry in walkdir::WalkDir::new(root) {
            let entry = entry.unwrap();
            if entry.file_type().is_dir() || entry.path() == root {
                continue;
            }
            let ext = entry.path().extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext == "tgz" || ext == "zip" {
                continue; // the archive we built
            }
            assert!(
                entry.path().starts_with(destination),
                "extraction wrote {}, which is outside the destination {}",
                entry.path().display(),
                destination.display()
            );
        }
    }

    fn no_progress() -> Progress {
        Box::new(|_| Ok(()))
    }

    fn hostile_entries() -> Vec<TarEntry> {
        HOSTILE_MEMBERS.iter().map(|name| file(name, "pwned\n")).collect()
    }

    fn assert_classic_landing_spots_are_empty(root: &Path) {
        for escaped in [
            root.join("escaped.txt"),
            root.parent().unwrap().join("escaped.txt"),
            root.join("windows").join("escaped.txt"),
        ] {
            assert!(
                std::fs::symlink_metadata(&escaped).is_err(),
                "{} was written outside the destination",
                escaped.display()
            );
        }
    }

    #[test]
    fn extract_tar_keeps_hostile_members_inside_the_destination() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("dest");
        let source = root.path().join("payload.tgz");
        build_tar_gz(&source, &hostile_entries());
        std::fs::create_dir_all(&destination).unwrap();

        extract_tar(
            &Ctx::background(),
            source.to_str().unwrap(),
            destination.to_str().unwrap(),
            true,
            &no_progress(),
        )
        .unwrap();

        assert_nothing_outside(root.path(), &destination);
        // Nothing may have been created beside the destination either, so
        // the classic landing spots are checked by name as well.
        assert_classic_landing_spots_are_empty(root.path());
    }

    #[test]
    fn extract_zip_keeps_hostile_members_inside_the_destination() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("dest");
        let source = root.path().join("payload.zip");
        build_zip(&source, &hostile_entries());
        std::fs::create_dir_all(&destination).unwrap();

        extract_zip(
            &Ctx::background(),
            source.to_str().unwrap(),
            destination.to_str().unwrap(),
            true,
            &no_progress(),
        )
        .unwrap();

        assert_nothing_outside(root.path(), &destination);
        assert_classic_landing_spots_are_empty(root.path());
    }

    // A symlink member is the second half of the attack: the link itself
    // is harmless, and the regular member written *through* it a moment
    // later is what lands on /etc. Refusing the link is the only place
    // this can be stopped, because by the time the second member is
    // opened the kernel has already followed it.
    #[test]
    fn extract_tar_refuses_a_symlink_that_leaves_the_destination() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("dest");
        let source = root.path().join("payload.tgz");
        build_tar_gz(&source, &[link("pwn", "../../"), file("pwn/loot.txt", "owned\n")]);
        std::fs::create_dir_all(&destination).unwrap();

        let err = extract_tar(
            &Ctx::background(),
            source.to_str().unwrap(),
            destination.to_str().unwrap(),
            true,
            &no_progress(),
        )
        .expect_err("a symlink member pointing out of the destination was accepted");
        assert!(matches!(err, ProviderError::PermissionDenied(_)), "{err:?}");
        assert_nothing_outside(root.path(), &destination);
    }

    #[test]
    fn contained_path_clamps_every_member_into_the_destination() {
        const DESTINATION: &str = "/var/www/uploads";
        let cases = [
            ("index.html", "/var/www/uploads/index.html"),
            ("a/b/c.txt", "/var/www/uploads/a/b/c.txt"),
            ("./a/./b.txt", "/var/www/uploads/a/b.txt"),
            // Every one of these is the same claim: whatever the member
            // calls itself, it resolves under the destination and nowhere
            // else.
            ("../escaped.txt", "/var/www/uploads/escaped.txt"),
            ("../../../../etc/shadow", "/var/www/uploads/etc/shadow"),
            ("/etc/shadow", "/var/www/uploads/etc/shadow"),
            ("//etc//shadow", "/var/www/uploads/etc/shadow"),
            ("a/../../escaped.txt", "/var/www/uploads/escaped.txt"),
            (r"..\escaped.txt", "/var/www/uploads/escaped.txt"),
            (
                r"..\..\..\windows\system32\drivers\etc\hosts",
                "/var/www/uploads/windows/system32/drivers/etc/hosts",
            ),
        ];
        for (name, want) in cases {
            let got =
                contained_path(DESTINATION, name).unwrap_or_else(|e| panic!("contained_path({name:?}): {e}"));
            assert_eq!(got, want, "contained_path({name:?})");
            assert!(within(&got, DESTINATION));
        }
    }

    #[test]
    fn contained_path_refuses_a_null_byte_in_a_member_name() {
        // A null byte truncates the name at whatever opens it, so the path
        // that was checked and the path that is created stop being the same.
        let err = contained_path("/var/www", "index.html\0/../../etc/shadow").unwrap_err();
        assert!(matches!(err, ProviderError::InvalidParams(_)), "{err:?}");
    }

    #[test]
    fn contained_link_separates_links_that_stay_from_links_that_leave() {
        const DESTINATION: &str = "/var/www/uploads";
        let cases = [
            ("sibling", "a/link", "b.txt", true),
            ("child", "link", "assets/logo.png", true),
            ("back up and in again", "a/b/link", "../../assets/logo.png", true),
            (
                "absolute but inside",
                "link",
                "/var/www/uploads/assets/logo.png",
                true,
            ),
            ("one level out", "link", "../escaped", false),
            ("far out", "a/b/link", "../../../../../../etc", false),
            ("out of the destination's parent", "link", "../../", false),
            ("absolute", "link", "/etc/shadow", false),
            (
                "absolute onto a sibling directory",
                "link",
                "/var/www/uploads-old",
                false,
            ),
            ("windows separators", "link", r"..\..\escaped", false),
            ("empty target", "link", "", false),
            ("null byte", "link", "assets\0/../../etc", false),
        ];
        for (name, member, linkname, ok) in cases {
            let result = contained_link(DESTINATION, member, linkname);
            assert_eq!(
                result.is_ok(),
                ok,
                "{name}: contained_link({member:?} -> {linkname:?}) = {result:?}"
            );
        }
    }

    // A member whose header understates its size is how a zip bomb gets
    // past a size check: the header says four bytes, the stream keeps
    // coming.
    #[test]
    fn write_member_refuses_a_member_bigger_than_its_header_claims() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("member.txt");
        let body = "this body is very much longer than four bytes";

        let err = write_member(target.to_str().unwrap(), &mut body.as_bytes(), 0o644, true, 4).unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err:?}");
        // The partial file is unlinked outright: a header which lied never
        // yields the member it was hiding.
        assert!(!target.exists());
    }

    #[test]
    fn write_member_refuses_to_overwrite_when_not_asked() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("keep.txt");
        std::fs::write(&target, "original\n").unwrap();

        let err = write_member(
            target.to_str().unwrap(),
            &mut "replacement".as_bytes(),
            0o644,
            false,
            11,
        )
        .unwrap_err();
        assert!(matches!(err, ProviderError::Conflict(_)), "{err:?}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original\n");
    }

    /* The verbs themselves, against a scratch tree. */

    fn test_shared() -> Arc<Shared> {
        let (events, _rx) = tokio::sync::mpsc::channel(1);
        Arc::new(Shared {
            opts: Options {
                agent_version: "test".into(),
                state_dir: std::env::temp_dir(),
            },
            caps: Default::default(),
            cap_list: Vec::new(),
            docker: None,
            rollback: super::super::rollback::RollbackGuard::new(),
            names: Default::default(),
            events,
            last_metrics: parking_lot::Mutex::new(None),
            ptys: super::super::pty::PtySessions::default(),
        })
    }

    /// A stream that remembers what was sent and plays back a fixed set of
    /// chunks, then reports EOF.
    /// Every chunk a test stream was handed, with its encoding.
    type Sent = Vec<(Vec<u8>, Encoding)>;

    #[derive(Default)]
    struct Recorder {
        inbox: tokio::sync::Mutex<VecDeque<Vec<u8>>>,
        sent: parking_lot::Mutex<Sent>,
    }

    #[async_trait]
    impl Stream for Recorder {
        async fn send(&self, data: &[u8], enc: Encoding) -> PResult<()> {
            self.sent.lock().push((data.to_vec(), enc));
            Ok(())
        }
        async fn recv(&self) -> PResult<Option<Vec<u8>>> {
            Ok(self.inbox.lock().await.pop_front())
        }
    }

    impl Recorder {
        fn lines(&self) -> Vec<String> {
            self.sent
                .lock()
                .iter()
                .filter(|(_, enc)| *enc == Encoding::Utf8)
                .map(|(d, _)| String::from_utf8_lossy(d).trim_end().to_string())
                .collect()
        }
    }

    fn s(p: &Path) -> String {
        p.to_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn list_sorts_directories_first_and_applies_hidden_and_limit() {
        let root = tempfile::tempdir().unwrap();
        for name in ["b.txt", "a.txt", ".hidden", "zdir/", "adir/"] {
            if let Some(dir) = name.strip_suffix('/') {
                std::fs::create_dir(root.path().join(dir)).unwrap();
            } else {
                std::fs::write(root.path().join(name), "x").unwrap();
            }
        }
        let ops = FileOps(test_shared());
        let ctx = Ctx::background();

        let listing = ops
            .list(
                &ctx,
                FsListParams {
                    path: s(root.path()),
                    show_hidden: false,
                    limit: 0,
                },
            )
            .await
            .unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["adir", "zdir", "a.txt", "b.txt"]);
        assert_eq!(listing.total, 4);
        assert!(!listing.truncated);
        assert_eq!(
            listing.parent.as_deref(),
            Some(root.path().parent().unwrap().to_str().unwrap())
        );
        let a = listing.entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert_eq!(a.kind, "file");
        assert_eq!(a.mime.as_deref(), Some("text/plain"));
        assert!(a.is_editable);
        assert!(!a.owner.is_empty());

        let listing = ops
            .list(
                &ctx,
                FsListParams {
                    path: s(root.path()),
                    show_hidden: true,
                    limit: 2,
                },
            )
            .await
            .unwrap();
        assert_eq!(listing.total, 5);
        assert!(listing.truncated);
        assert_eq!(listing.entries.len(), 2);
    }

    #[tokio::test]
    async fn read_detects_text_and_binary_and_truncates() {
        let root = tempfile::tempdir().unwrap();
        let text = root.path().join("notes.txt");
        let binary = root.path().join("blob");
        std::fs::write(&text, "héllo world\n").unwrap();
        std::fs::write(&binary, [0u8, 1, 2, 255]).unwrap();
        let ops = FileOps(test_shared());
        let ctx = Ctx::background();

        let r = ops
            .read(
                &ctx,
                FsReadParams {
                    path: s(&text),
                    max_bytes: 0,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            (r.content.as_str(), r.encoding.as_str(), r.truncated),
            ("héllo world\n", "utf8", false)
        );
        assert_eq!(r.size, 13);

        let r = ops
            .read(
                &ctx,
                FsReadParams {
                    path: s(&binary),
                    max_bytes: 0,
                },
            )
            .await
            .unwrap();
        assert_eq!(r.encoding, "base64");
        assert_eq!(BASE64.decode(r.content).unwrap(), [0u8, 1, 2, 255]);

        let r = ops
            .read(
                &ctx,
                FsReadParams {
                    path: s(&text),
                    max_bytes: 5,
                },
            )
            .await
            .unwrap();
        assert!(r.truncated);
        assert_eq!(r.size, 13);

        let err = ops
            .read(
                &ctx,
                FsReadParams {
                    path: s(root.path()),
                    max_bytes: 0,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::InvalidParams(_)));
        let err = ops
            .read(
                &ctx,
                FsReadParams {
                    path: s(&root.path().join("missing")),
                    max_bytes: 0,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::NotFound(_)));
    }

    #[tokio::test]
    async fn write_mkdir_move_copy_remove_round_trip() {
        let root = tempfile::tempdir().unwrap();
        let ops = FileOps(test_shared());
        let ctx = Ctx::background();

        let target = root.path().join("etc/app/app.conf");
        let entry = ops
            .write(
                &ctx,
                FsWriteParams {
                    path: s(&target),
                    content: BASE64.encode("key=value\n"),
                    encoding: "base64".into(),
                    mode: Some("0600".into()),
                    create_parents: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(entry.mode, "0600");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "key=value\n");

        // A rewrite without a mode keeps the file's own.
        ops.write(
            &ctx,
            FsWriteParams {
                path: s(&target),
                content: "k=v\n".into(),
                encoding: "utf8".into(),
                mode: None,
                create_parents: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(std::fs::metadata(&target).unwrap().mode() & 0o777, 0o600);

        let dir = root.path().join("a/b/c");
        let entry = ops
            .mkdir(
                &ctx,
                FsMkdirParams {
                    path: s(&dir),
                    mode: Some("0750".into()),
                    parents: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            (entry.kind.as_str(), entry.mode.as_str(), entry.child_count),
            ("directory", "0750", Some(0))
        );
        let err = ops
            .mkdir(
                &ctx,
                FsMkdirParams {
                    path: s(&dir),
                    mode: None,
                    parents: false,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Conflict(_)), "{err:?}");

        let moved = root.path().join("a/moved.conf");
        ops.r#move(
            &ctx,
            FsMoveParams {
                from: s(&target),
                to: s(&moved),
                overwrite: false,
            },
        )
        .await
        .unwrap();
        assert!(!target.exists() && moved.exists());

        let copy = root.path().join("copy");
        let entry = ops
            .copy(
                &ctx,
                FsCopyParams {
                    from: s(&root.path().join("a")),
                    to: s(&copy),
                    overwrite: false,
                },
            )
            .await
            .unwrap();
        assert_eq!(entry.kind, "directory");
        assert_eq!(std::fs::read_to_string(copy.join("moved.conf")).unwrap(), "k=v\n");
        assert_eq!(std::fs::metadata(copy.join("b/c")).unwrap().mode() & 0o777, 0o750);
        let err = ops
            .copy(
                &ctx,
                FsCopyParams {
                    from: s(&root.path().join("a")),
                    to: s(&copy),
                    overwrite: false,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Conflict(_)));
        let err = ops
            .copy(
                &ctx,
                FsCopyParams {
                    from: s(&root.path().join("a")),
                    to: s(&root.path().join("a/inner")),
                    overwrite: true,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::InvalidParams(_)));

        let err = ops
            .remove(
                &ctx,
                FsRemoveParams {
                    paths: vec![s(&copy)],
                    recursive: false,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)));
        // copy, copy/moved.conf, copy/b, copy/b/c
        let removed = ops
            .remove(
                &ctx,
                FsRemoveParams {
                    paths: vec![s(&copy), s(&root.path().join("nope"))],
                    recursive: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(removed, 4);
        assert!(!copy.exists());
        let err = ops
            .remove(
                &ctx,
                FsRemoveParams {
                    paths: vec!["/usr".into()],
                    recursive: true,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::PermissionDenied(_)), "{err:?}");
    }

    #[tokio::test]
    async fn chmod_and_chown_walk_trees_only_when_asked() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("tree");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("f"), "x").unwrap();
        let ops = FileOps(test_shared());
        let ctx = Ctx::background();

        ops.chmod(
            &ctx,
            FsChmodParams {
                paths: vec![s(&dir)],
                mode: "0700".into(),
                recursive: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        assert_ne!(std::fs::metadata(dir.join("f")).unwrap().mode() & 0o777, 0o700);

        ops.chmod(
            &ctx,
            FsChmodParams {
                paths: vec![s(&dir)],
                mode: "0755".into(),
                recursive: true,
            },
        )
        .await
        .unwrap();
        assert_eq!(std::fs::metadata(dir.join("f")).unwrap().mode() & 0o777, 0o755);

        let err = ops
            .chmod(
                &ctx,
                FsChmodParams {
                    paths: vec![s(&dir)],
                    mode: "rwx".into(),
                    recursive: false,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::InvalidParams(_)));

        let err = ops
            .chown(
                &ctx,
                FsChownParams {
                    paths: vec![s(&dir)],
                    owner: Some("no-such-user-kaname".into()),
                    group: None,
                    recursive: false,
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::NotFound(_)));

        // Chowning to the caller's own account is always allowed.
        let me = nix::unistd::User::from_uid(nix::unistd::getuid())
            .unwrap()
            .unwrap();
        ops.chown(
            &ctx,
            FsChownParams {
                paths: vec![s(&dir)],
                owner: Some(me.name),
                group: None,
                recursive: true,
            },
        )
        .await
        .unwrap();
    }

    async fn archive_round_trip(format: &str, suffix: &str) {
        let root = tempfile::tempdir().unwrap();
        let site = root.path().join("site");
        std::fs::create_dir_all(site.join("assets")).unwrap();
        std::fs::write(site.join("index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(site.join("assets/app.js"), "console.log(1)").unwrap();
        std::fs::set_permissions(site.join("assets/app.js"), std::fs::Permissions::from_mode(0o751)).unwrap();
        let ops = FileOps(test_shared());
        let ctx = Ctx::background();

        let archive = root.path().join(format!("site.{suffix}"));
        let stream = Arc::new(Recorder::default());
        let entry = ops
            .archive(
                &ctx,
                FsArchiveParams {
                    paths: vec![s(&site)],
                    destination: s(&archive),
                    format: format.into(),
                },
                stream.clone(),
            )
            .await
            .unwrap();
        assert!(entry.size > 0);
        let mut lines = stream.lines();
        lines.sort();
        let want: Vec<String> = if format == "zip" {
            ["assets/app.js", "index.html", "site/", "site/assets/"]
                .iter()
                .map(|l| {
                    if l.starts_with("site") {
                        l.to_string()
                    } else {
                        format!("site/{l}")
                    }
                })
                .collect()
        } else {
            ["site", "site/assets", "site/assets/app.js", "site/index.html"]
                .iter()
                .map(|l| l.to_string())
                .collect()
        };
        let mut want = want;
        want.sort();
        assert_eq!(lines, want, "{format} progress lines");

        let out = root.path().join("out");
        let stream = Arc::new(Recorder::default());
        let count = ops
            .extract(
                &ctx,
                FsExtractParams {
                    path: s(&archive),
                    destination: s(&out),
                    overwrite: false,
                },
                stream.clone(),
            )
            .await
            .unwrap();
        assert_eq!(count, 4, "{format} extracted members");
        assert_eq!(
            std::fs::read_to_string(out.join("site/index.html")).unwrap(),
            "<h1>hi</h1>"
        );
        assert_eq!(
            std::fs::read_to_string(out.join("site/assets/app.js")).unwrap(),
            "console.log(1)"
        );
        assert_eq!(
            std::fs::metadata(out.join("site/assets/app.js")).unwrap().mode() & 0o777,
            0o751
        );

        // Extracting again without overwrite trips on the first file.
        let err = ops
            .extract(
                &ctx,
                FsExtractParams {
                    path: s(&archive),
                    destination: s(&out),
                    overwrite: false,
                },
                stream.clone(),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Conflict(_)), "{format}: {err:?}");
    }

    #[tokio::test]
    async fn archives_round_trip_in_every_format() {
        archive_round_trip("tar.gz", "tar.gz").await;
        archive_round_trip("tar.zst", "tar.zst").await;
        archive_round_trip("zip", "zip").await;
    }

    #[tokio::test]
    async fn archive_rejects_unknown_formats_and_extract_unknown_suffixes() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("x.rar"), "x").unwrap();
        let ops = FileOps(test_shared());
        let ctx = Ctx::background();
        let stream = Arc::new(Recorder::default());

        let err = ops
            .archive(
                &ctx,
                FsArchiveParams {
                    paths: vec![s(root.path())],
                    destination: s(&root.path().join("out.7z")),
                    format: "7z".into(),
                },
                stream.clone(),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::InvalidParams(_)));

        let err = ops
            .extract(
                &ctx,
                FsExtractParams {
                    path: s(&root.path().join("x.rar")),
                    destination: s(&root.path().join("out")),
                    overwrite: false,
                },
                stream,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Unsupported(_)));
    }

    #[tokio::test]
    async fn download_streams_base64_chunks_and_upload_assembles_them() {
        let root = tempfile::tempdir().unwrap();
        let big = root.path().join("big.bin");
        let payload: Vec<u8> = (0..(TRANSFER_CHUNK + 10)).map(|i| (i % 251) as u8).collect();
        std::fs::write(&big, &payload).unwrap();
        let ops = FileOps(test_shared());
        let ctx = Ctx::background();

        let stream = Arc::new(Recorder::default());
        let result = ops
            .download(&ctx, FsDownloadParams { path: s(&big) }, stream.clone())
            .await
            .unwrap();
        assert_eq!(result.size as usize, payload.len());
        assert_eq!(result.mime, "application/octet-stream");
        {
            let sent = stream.sent.lock();
            assert_eq!(sent.len(), 2);
            assert!(sent.iter().all(|(_, enc)| *enc == Encoding::Base64));
            let joined: Vec<u8> = sent.iter().flat_map(|(d, _)| d.clone()).collect();
            assert_eq!(joined, payload);
        }

        let err = ops
            .download(&ctx, FsDownloadParams { path: s(root.path()) }, stream.clone())
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::InvalidParams(_)));

        let target = root.path().join("uploads/new.bin");
        let stream = Arc::new(Recorder {
            inbox: tokio::sync::Mutex::new(VecDeque::from(vec![
                payload[..1000].to_vec(),
                payload[1000..].to_vec(),
            ])),
            ..Default::default()
        });
        let entry = ops
            .upload(
                &ctx,
                FsUploadParams {
                    path: s(&target),
                    size: payload.len() as i64,
                    mode: Some("0640".into()),
                    overwrite: false,
                },
                stream,
            )
            .await
            .unwrap();
        assert_eq!(entry.size as usize, payload.len());
        assert_eq!(entry.mode, "0640");
        assert_eq!(std::fs::read(&target).unwrap(), payload);
        // No temp file survives beside the result.
        assert_eq!(std::fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);

        // A declared size that the chunks exceed is refused, and the
        // existing file is untouched.
        let stream = Arc::new(Recorder {
            inbox: tokio::sync::Mutex::new(VecDeque::from(vec![vec![1u8; 10]])),
            ..Default::default()
        });
        let err = ops
            .upload(
                &ctx,
                FsUploadParams {
                    path: s(&target),
                    size: 5,
                    mode: None,
                    overwrite: true,
                },
                stream,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err:?}");
        assert_eq!(std::fs::read(&target).unwrap(), payload);
        assert_eq!(std::fs::read_dir(target.parent().unwrap()).unwrap().count(), 1);

        let stream = Arc::new(Recorder::default());
        let err = ops
            .upload(
                &ctx,
                FsUploadParams {
                    path: s(&target),
                    size: 0,
                    mode: None,
                    overwrite: false,
                },
                stream,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ProviderError::Conflict(_)));
    }

    /// The control plane never closes an upload's input: the declared
    /// size is the end marker. A provider that read until the stream
    /// closed hung every real upload.
    struct NeverEnds(tokio::sync::Mutex<VecDeque<Vec<u8>>>);

    #[async_trait]
    impl Stream for NeverEnds {
        async fn send(&self, _data: &[u8], _enc: Encoding) -> PResult<()> {
            Ok(())
        }
        async fn recv(&self) -> PResult<Option<Vec<u8>>> {
            let next = self.0.lock().await.pop_front();
            match next {
                Some(chunk) => Ok(Some(chunk)),
                None => std::future::pending().await,
            }
        }
    }

    #[tokio::test]
    async fn upload_finishes_at_the_declared_size_without_an_end_of_input() {
        let root = tempfile::tempdir().unwrap();
        let ops = FileOps(test_shared());
        let ctx = Ctx::background();
        let target = root.path().join("open-ended.bin");

        let stream = Arc::new(NeverEnds(tokio::sync::Mutex::new(VecDeque::from(vec![
            vec![7u8; 6],
            vec![9u8; 4],
        ]))));
        let params = FsUploadParams {
            path: s(&target),
            size: 10,
            mode: None,
            overwrite: false,
        };
        let entry = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            ops.upload(&ctx, params, stream),
        )
        .await
        .expect("an upload that has its declared bytes must not wait for more")
        .unwrap();
        assert_eq!(entry.size, 10);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            [vec![7u8; 6], vec![9u8; 4]].concat()
        );

        // An empty file needs no chunk at all.
        let empty = root.path().join("empty.bin");
        let stream = Arc::new(NeverEnds(tokio::sync::Mutex::new(VecDeque::new())));
        let params = FsUploadParams {
            path: s(&empty),
            size: 0,
            mode: None,
            overwrite: false,
        };
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            ops.upload(&ctx, params, stream),
        )
        .await
        .expect("an empty upload must not wait for a chunk")
        .unwrap();
        assert_eq!(std::fs::read(&empty).unwrap().len(), 0);

        // A body that stops short of the declared size is refused.
        let short = root.path().join("short.bin");
        let stream = Arc::new(Recorder {
            inbox: tokio::sync::Mutex::new(VecDeque::from(vec![vec![1u8; 3]])),
            ..Default::default()
        });
        let params = FsUploadParams {
            path: s(&short),
            size: 8,
            mode: None,
            overwrite: false,
        };
        let err = ops.upload(&ctx, params, stream).await.unwrap_err();
        assert!(matches!(err, ProviderError::PreconditionFailed(_)), "{err:?}");
        assert!(!short.exists());
    }

    #[tokio::test]
    async fn usage_reports_directories_with_their_full_recursive_size() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("big/inner")).unwrap();
        std::fs::create_dir_all(root.path().join("small")).unwrap();
        std::fs::write(root.path().join("big/inner/x"), vec![0u8; 3000]).unwrap();
        std::fs::write(root.path().join("big/y"), vec![0u8; 1000]).unwrap();
        std::fs::write(root.path().join("small/z"), vec![0u8; 10]).unwrap();
        std::fs::write(root.path().join("loose"), vec![0u8; 5]).unwrap();
        let ops = FileOps(test_shared());
        let ctx = Ctx::background();

        let usage = ops
            .usage(
                &ctx,
                FsUsageParams {
                    path: s(root.path()),
                    depth: 0,
                },
            )
            .await
            .unwrap();
        assert_eq!(usage.total, 4015);
        let labels: Vec<&str> = usage
            .entries
            .iter()
            .map(|e| e.label.as_deref().unwrap())
            .collect();
        assert_eq!(labels, ["big", "small"]);
        assert_eq!(usage.entries[0].bytes, 4000);
        assert_eq!(usage.entries[0].inodes, Some(4));
        assert_eq!(usage.entries[0].kind, "directory");

        let usage = ops
            .usage(
                &ctx,
                FsUsageParams {
                    path: s(root.path()),
                    depth: 2,
                },
            )
            .await
            .unwrap();
        let labels: Vec<&str> = usage
            .entries
            .iter()
            .map(|e| e.label.as_deref().unwrap())
            .collect();
        assert_eq!(labels, ["big", "inner", "small"]);
        // A deeper breakdown never changes the total.
        assert_eq!(usage.total, 4015);
    }

    #[tokio::test]
    async fn stat_describes_symlinks_without_following_them() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("real"), "x").unwrap();
        std::os::unix::fs::symlink("real", root.path().join("link")).unwrap();
        let ops = FileOps(test_shared());
        let entry = ops
            .stat(&Ctx::background(), root.path().join("link").to_str().unwrap())
            .await
            .unwrap();
        assert_eq!(entry.kind, "symlink");
        assert_eq!(entry.link_target.as_deref(), Some("real"));
        assert!(entry.mime.is_none());
    }

    #[test]
    fn editable_rule_combines_size_mime_and_a_text_sample() {
        let root = tempfile::tempdir().unwrap();
        let conf = root.path().join("nginx.conf");
        std::fs::write(&conf, "server {}").unwrap();
        let blob = root.path().join("blob.bin");
        std::fs::write(&blob, [0u8, 159, 146, 150]).unwrap();
        let noext = root.path().join("README");
        std::fs::write(&noext, "plain words").unwrap();

        assert!(is_editable_mime(
            &mime_type(conf.to_str().unwrap()),
            conf.to_str().unwrap()
        ));
        assert_eq!(mime_type(blob.to_str().unwrap()), "application/octet-stream");
        assert!(!is_editable_mime(
            "application/octet-stream",
            blob.to_str().unwrap()
        ));
        assert_eq!(mime_type(noext.to_str().unwrap()), "text/plain");
        assert!(is_textual(b""));
        assert!(!is_textual(b"a\0b"));
        assert!(!is_textual(&[0xff, 0xfe]));
    }
}
