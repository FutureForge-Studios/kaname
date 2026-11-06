//! Replacing the agent with a verified build.
//!
//! Two rules hold here. The digest is checked before the download is ever
//! made executable, so a truncated transfer or a substituted artifact
//! cannot become the thing that runs as root on the next boot. And the
//! binary that was running is kept, so an agent that comes back broken
//! can be put back by hand from the box itself.
//!
//! The awkward part of updating an agent is that the thing being replaced
//! is the thing answering the request. So `self_update` does everything
//! it can while it is still alive — download, verify, keep a copy of the
//! current build, swap — reports "restarting", and only then asks systemd
//! for a new process. Claiming success from a process that is about to
//! die would be a claim it has no way to check.

use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use super::Shared;
use crate::providers::{Ctx, PResult, ProviderError, SelfUpdateParams, SelfUpdateResult, StreamRef, say};

/// The message a mismatched download fails with; callers and tests match
/// on it the way the Go code matched `ErrDigestMismatch`.
pub const DIGEST_MISMATCH: &str = "downloaded binary does not match the expected sha256";

/// Caps a download. The agent is a single static binary of a few tens of
/// megabytes; anything an order of magnitude larger is a misconfiguration
/// or something worse, and filling the disk of a managed host is not an
/// acceptable way to find out.
pub const MAX_BINARY_BYTES: u64 = 256 << 20;

/// Long enough for the response and its stream to reach the control plane
/// before this process goes away.
const RESTART_DELAY: Duration = Duration::from_millis(1500);

/// Fetches `url` into `dst` and verifies its digest. On any failure `dst`
/// is removed, so a half-written file can never be swapped in.
pub async fn download(client: &reqwest::Client, url: &str, want: &str, dst: &Path) -> PResult<()> {
    let want = want.trim().to_lowercase();
    if want.len() != 64 {
        return Err(ProviderError::invalid(format!(
            "expected a 64-character sha256, got {} characters",
            want.len()
        )));
    }

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| ProviderError::internal(format!("downloading {url}: {e}")))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(ProviderError::internal(format!(
            "downloading {url}: the server answered {}",
            response.status()
        )));
    }

    // Not executable: nothing that lists or runs `*.new` next to the real
    // binary may treat these bytes as a build until the digest has said
    // they are one. `swap` is what makes the verified file runnable.
    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(0o600)
        .open(dst)
        .await?;

    let outcome = async {
        let mut digest = Sha256::new();
        let mut written: u64 = 0;
        let mut body = response.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = chunk.map_err(|e| ProviderError::internal(format!("downloading {url}: {e}")))?;
            written += chunk.len() as u64;
            if written > MAX_BINARY_BYTES {
                return Err(ProviderError::internal(format!(
                    "the binary at {url} is larger than {MAX_BINARY_BYTES} bytes"
                )));
            }
            digest.update(&chunk);
            file.write_all(&chunk).await?;
        }
        // Flushed before the digest is trusted, so the bytes it covered are
        // the bytes on disk when `swap` renames the file into place.
        file.sync_all().await?;
        drop(file);

        let got = hex::encode(digest.finalize());
        if got != want {
            return Err(ProviderError::PreconditionFailed(format!(
                "{DIGEST_MISMATCH}: expected {want}, got {got}"
            )));
        }
        Ok(())
    }
    .await;

    if outcome.is_err() {
        let _ = tokio::fs::remove_file(dst).await;
    }
    outcome
}

/// Puts `staged` in place of `binary`, keeping the previous build at
/// `backup`.
///
/// The order matters. The backup is a copy rather than a move, so the
/// running binary is never absent from its own path; the new build then
/// arrives by rename, which is atomic within a filesystem. On Linux,
/// renaming over a running executable is allowed — the kernel keeps the
/// old inode alive for the process that is executing it, which is exactly
/// why the caller can go on to answer the request that asked for this.
pub fn swap(binary: &Path, staged: &Path, backup: &Path) -> PResult<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

    if let Some(parent) = backup.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
    }
    copy_file(binary, backup, 0o700)
        .map_err(|e| ProviderError::internal(format!("keeping a copy of the current binary: {e}")))?;
    std::fs::set_permissions(staged, std::fs::Permissions::from_mode(0o755))?;
    std::fs::rename(staged, binary)
        .map_err(|e| ProviderError::internal(format!("replacing {}: {e}", binary.display())))?;
    Ok(())
}

fn copy_file(from: &Path, to: &Path, mode: u32) -> std::io::Result<()> {
    let mut source = std::fs::File::open(from)?;
    let mut target = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .mode(mode)
        .open(to)?;
    std::io::copy(&mut source, &mut target)?;
    target.sync_all()
}

/// The `system.selfUpdate` verb for the real provider.
pub async fn self_update(
    shared: &Arc<Shared>,
    ctx: &Ctx,
    p: SelfUpdateParams,
    s: StreamRef,
) -> PResult<SelfUpdateResult> {
    let binary = std::env::current_exe()
        .map_err(|e| ProviderError::internal(format!("finding the running agent binary: {e}")))?;
    let binary = std::fs::canonicalize(&binary)
        .map_err(|e| ProviderError::internal(format!("resolving {}: {e}", binary.display())))?;

    let staged = PathBuf::from(format!("{}.new", binary.display()));
    let backup = shared.opts.state_dir.join("kanamed.previous");

    say(s.as_ref(), format!("downloading kanamed {}", p.version)).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10 * 60))
        .build()
        .map_err(|e| ProviderError::internal(format!("building the download client: {e}")))?;
    ctx.run(download(&client, &p.url, &p.sha256, &staged)).await??;
    say(s.as_ref(), "sha256 verified").await;

    say(
        s.as_ref(),
        format!("keeping the current binary at {}", backup.display()),
    )
    .await;
    swap(&binary, &staged, &backup)?;
    say(
        s.as_ref(),
        format!("installed {} at {}", p.version, binary.display()),
    )
    .await;
    say(
        s.as_ref(),
        format!(
            "restarting; the control plane will see this agent reconnect at {}",
            p.version
        ),
    )
    .await;

    // Signalled rather than exec'd: systemd owns this unit's lifecycle,
    // Restart=always brings it straight back, and re-execing would leave
    // the unit pointing at a process systemd did not start.
    let version = p.version.clone();
    tokio::spawn(async move {
        tokio::time::sleep(RESTART_DELAY).await;
        tracing::info!(version = %version, "restarting after self-update");
        let _ = nix::sys::signal::kill(nix::unistd::getpid(), nix::sys::signal::Signal::SIGTERM);
    });

    Ok(SelfUpdateResult {
        previous_version: shared.opts.agent_version.clone(),
        version: p.version,
        restarting: true,
        previous_binary_path: backup.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;

    fn digest(b: &[u8]) -> String {
        hex::encode(Sha256::digest(b))
    }

    /// Serves one fixed HTTP response on a loopback port and returns its
    /// URL. Enough of HTTP/1.1 for reqwest to read a body.
    async fn serve(body: Vec<u8>, status: u16) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/kanamed", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = socket.read(&mut buf).await;
                    let reason = if status == 200 { "OK" } else { "Not Found" };
                    let head = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        url
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn download_verifies_the_digest() {
        let payload = b"#!/bin/true\nthis is the new agent\n".to_vec();
        let url = serve(payload.clone(), 200).await;
        let dir = tempfile::tempdir().unwrap();
        let dst = dir.path().join("kanamed.new");

        download(&client(), &url, &digest(&payload), &dst).await.unwrap();

        assert_eq!(std::fs::read(&dst).unwrap(), payload);
        // Verified, but not yet runnable: that is swap's decision to make.
        let mode = std::fs::metadata(&dst).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "the staged download is {mode:o}, want 0600 until it is swapped in"
        );
    }

    #[tokio::test]
    async fn download_refuses_a_mismatched_digest() {
        let url = serve(b"something else entirely".to_vec(), 200).await;
        let dir = tempfile::tempdir().unwrap();
        let dst = dir.path().join("kanamed.new");

        let err = download(&client(), &url, &digest(b"expected"), &dst)
            .await
            .unwrap_err();
        assert!(err.to_string().contains(DIGEST_MISMATCH), "{err}");
        // The whole point: nothing is left behind that could be swapped in.
        assert!(!dst.exists(), "the rejected download is still on disk");
    }

    #[tokio::test]
    async fn download_refuses_a_short_digest() {
        let url = serve(b"payload".to_vec(), 200).await;
        let dir = tempfile::tempdir().unwrap();
        let err = download(&client(), &url, "abc123", &dir.path().join("x"))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("64-character"), "{err}");
    }

    #[tokio::test]
    async fn download_reports_an_http_failure() {
        let url = serve(b"not found".to_vec(), 404).await;
        let dir = tempfile::tempdir().unwrap();
        let dst = dir.path().join("kanamed.new");
        let err = download(&client(), &url, &digest(b"x"), &dst).await.unwrap_err();
        assert!(err.to_string().contains("404"), "{err}");
        assert!(!dst.exists(), "a failed download left a file behind");
    }

    #[test]
    fn swap_keeps_the_previous_binary() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("kanamed");
        let staged = dir.path().join("kanamed.new");
        let backup = dir.path().join("state").join("kanamed.previous");
        std::fs::write(&binary, "old build").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(&staged, "new build").unwrap();
        std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o600)).unwrap();

        swap(&binary, &staged, &backup).unwrap();

        assert_eq!(std::fs::read_to_string(&binary).unwrap(), "new build");
        assert_eq!(
            std::fs::metadata(&binary).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(std::fs::read_to_string(&backup).unwrap(), "old build");
        // The staged file is consumed by the rename, so a second swap
        // cannot silently re-apply a stale download.
        assert!(!staged.exists(), "the staged file survived the swap");
    }

    #[test]
    fn swap_refuses_when_there_is_nothing_to_back_up() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("kanamed.new");
        std::fs::write(&staged, "new build").unwrap();
        assert!(swap(&dir.path().join("missing"), &staged, &dir.path().join("backup")).is_err());
    }
}
