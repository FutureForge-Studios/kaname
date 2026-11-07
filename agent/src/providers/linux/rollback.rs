//! The rollback window.
//!
//! `RollbackGuard` is the lockout-safe apply window shared by fw.apply and
//! ssh.config.apply: the change goes in, a revert is scheduled, and only a
//! confirm carrying the matching token cancels it. It is the difference
//! between a mistyped rule and a box you can no longer reach.
//!
//! This file carries no syscalls on purpose: when an unconfirmed change
//! reverts is decided here and proved by plain unit tests, so the host a
//! Kaname agent manages is always Linux but this logic compiles and is
//! tested everywhere.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use parking_lot::Mutex;
use rand::RngCore;
use tokio::task::JoinHandle;

use crate::providers::{PResult, ProviderError};

/// How long a scheduled revert may take before it is given up on.
const REVERT_TIMEOUT: Duration = Duration::from_secs(60);

/// The action that puts a host back: a closure producing the future that
/// restores the snapshot it closed over.
pub type RevertFn = Box<dyn Fn() -> BoxFuture<'static, PResult<()>> + Send + Sync>;

struct PendingRevert {
    timer: JoinHandle<()>,
    scope: String,
}

#[derive(Default)]
struct Inner {
    pending: Mutex<HashMap<String, PendingRevert>>,
}

/// Arms, confirms and fires timed reverts. Timers are tokio tasks, so
/// `arm` must run on a runtime.
pub struct RollbackGuard {
    inner: Arc<Inner>,
}

impl RollbackGuard {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner::default()),
        }
    }

    /// Schedules `revert` unless a matching confirm arrives first. A window
    /// of zero means the caller took responsibility and no revert is armed.
    pub async fn arm(&self, scope: &str, seconds: i64, revert: RevertFn) -> PResult<Option<String>> {
        if seconds <= 0 {
            return Ok(None);
        }

        let mut raw = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut raw);
        let token = hex::encode(raw);

        let mut pending = self.inner.pending.lock();

        // One armed window per scope: a second apply supersedes the first, and
        // leaving both timers running would revert to the wrong snapshot.
        let superseded: Vec<String> = pending
            .iter()
            .filter(|(_, entry)| entry.scope == scope)
            .map(|(existing, _)| existing.clone())
            .collect();
        for existing in superseded {
            if let Some(entry) = pending.remove(&existing) {
                entry.timer.abort();
            }
        }

        let inner = self.inner.clone();
        let fired_token = token.clone();
        let fired_scope = scope.to_string();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(seconds as u64)).await;
            inner.pending.lock().remove(&fired_token);

            match tokio::time::timeout(REVERT_TIMEOUT, revert()).await {
                Ok(Ok(())) => tracing::warn!(scope = %fired_scope, "rolled back unconfirmed change"),
                Ok(Err(err)) => tracing::error!(scope = %fired_scope, error = %err, "rollback failed"),
                Err(_) => tracing::error!(scope = %fired_scope, "rollback failed: the revert timed out"),
            }
        });
        pending.insert(
            token.clone(),
            PendingRevert {
                timer,
                scope: scope.to_string(),
            },
        );

        Ok(Some(token))
    }

    /// Cancels the revert the token stands for. A token that was never
    /// issued, was superseded or has already fired is reported as not
    /// found rather than silently accepted, or the panel would show a change
    /// as kept that the host has already thrown away.
    pub async fn confirm(&self, token: &str) -> PResult<()> {
        let mut pending = self.inner.pending.lock();
        match pending.remove(token) {
            Some(entry) => {
                entry.timer.abort();
                Ok(())
            }
            None => Err(ProviderError::not_found("no pending change carries that token")),
        }
    }

    /// Disarms everything at shutdown. Closing the provider means the agent
    /// is going away; reverting on the way out would undo a change during a
    /// routine restart.
    pub async fn stop(&self) {
        let mut pending = self.inner.pending.lock();
        for (_, entry) in pending.drain() {
            entry.timer.abort();
        }
    }

    /// How many windows are armed, read under the guard's own lock because
    /// a timer task may be unwinding one of them while the caller looks.
    #[cfg(test)]
    pub fn armed_count(&self) -> usize {
        self.inner.pending.lock().len()
    }
}

impl Default for RollbackGuard {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    /* ------------------------------------------------------------------ *
     * fw.apply and ssh.config.apply are the two verbs that can put a remote
     * host out of reach. Both survive a mistake the same way: install the
     * change, arm a revert, and let only a matching confirm cancel it. The
     * window is expressed in whole seconds by the contract, so these tests
     * use the shortest real window there is rather than pretending to
     * inject a clock the type does not take.
     * ------------------------------------------------------------------ */

    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::sync::mpsc;

    use super::*;

    /// A revert that records that it fired, so a test can wait for it rather
    /// than sleep and hope.
    struct RevertSpy {
        fired: tokio::sync::Mutex<mpsc::UnboundedReceiver<()>>,
        tx: mpsc::UnboundedSender<()>,
        count: Arc<AtomicUsize>,
        err: Option<String>,
    }

    impl RevertSpy {
        fn new() -> Self {
            let (tx, rx) = mpsc::unbounded_channel();
            Self {
                fired: tokio::sync::Mutex::new(rx),
                tx,
                count: Arc::new(AtomicUsize::new(0)),
                err: None,
            }
        }

        fn failing(message: &str) -> Self {
            let mut spy = Self::new();
            spy.err = Some(message.to_string());
            spy
        }

        fn revert(&self) -> RevertFn {
            let tx = self.tx.clone();
            let count = self.count.clone();
            let err = self.err.clone();
            Box::new(move || {
                let tx = tx.clone();
                let count = count.clone();
                let err = err.clone();
                Box::pin(async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    let _ = tx.send(());
                    match err {
                        Some(message) => Err(ProviderError::internal(message)),
                        None => Ok(()),
                    }
                })
            })
        }

        fn calls(&self) -> usize {
            self.count.load(Ordering::SeqCst)
        }

        /// Waits for the window to lapse, with generous slack so a loaded CI
        /// box does not fail a timing test that is really about state.
        async fn await_revert(&self) {
            let mut rx = self.fired.lock().await;
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(())) => {}
                _ => panic!("the window lapsed but the change was never reverted"),
            }
        }

        async fn assert_quiet(&self, within: Duration) {
            let mut rx = self.fired.lock().await;
            if let Ok(Some(())) = tokio::time::timeout(within, rx.recv()).await {
                panic!("a confirmed change was reverted anyway");
            }
        }
    }

    fn is_not_found(result: &PResult<()>) -> bool {
        matches!(result, Err(ProviderError::NotFound(_)))
    }

    #[tokio::test]
    async fn arming_with_no_window_schedules_nothing() {
        let guard = RollbackGuard::new();
        let spy = RevertSpy::new();

        // A zero window is the caller saying it takes responsibility, so there
        // is no token to confirm and nothing to time out.
        let token = guard.arm("firewall", 0, spy.revert()).await.unwrap();
        assert!(token.is_none(), "a zero window returned the token {token:?}");
        assert_eq!(guard.armed_count(), 0, "a zero window left armed reverts");

        let token = guard.arm("firewall", -30, spy.revert()).await.unwrap();
        assert!(token.is_none(), "a negative window returned {token:?}");
        spy.assert_quiet(Duration::from_millis(100)).await;
    }

    #[tokio::test]
    async fn an_unconfirmed_change_reverts_when_the_window_lapses() {
        let guard = RollbackGuard::new();
        let spy = RevertSpy::new();

        let token = guard.arm("firewall", 1, spy.revert()).await.unwrap();
        let token = token.expect("arming a real window returned no token");
        assert!(!token.is_empty());

        spy.await_revert().await;
        assert_eq!(spy.calls(), 1, "the revert ran more than once");

        // A window that has already fired is spent: confirming it afterwards
        // must say so rather than silently succeeding, or the panel would show
        // a change as kept that the host has already thrown away.
        assert!(
            is_not_found(&guard.confirm(&token).await),
            "confirming a lapsed window succeeded"
        );
        guard.stop().await;
    }

    #[tokio::test]
    async fn confirming_cancels_the_revert() {
        let guard = RollbackGuard::new();
        let spy = RevertSpy::new();

        let token = guard.arm("firewall", 1, spy.revert()).await.unwrap().unwrap();
        guard.confirm(&token).await.unwrap();
        assert_eq!(guard.armed_count(), 0, "confirming left armed reverts");

        // Well past the window it was armed for.
        spy.assert_quiet(Duration::from_millis(1500)).await;
        assert_eq!(spy.calls(), 0, "the revert ran after a confirm");
        guard.stop().await;
    }

    #[tokio::test]
    async fn confirming_with_the_wrong_token_changes_nothing() {
        let guard = RollbackGuard::new();
        let spy = RevertSpy::new();

        let token = guard.arm("firewall", 1, spy.revert()).await.unwrap().unwrap();
        for wrong in ["", "not-a-token", &format!("{token}0"), &token[1..]] {
            assert!(
                is_not_found(&guard.confirm(wrong).await),
                "confirm({wrong:?}) did not report not found"
            );
        }
        // The real window is untouched by the failed attempts and still fires.
        spy.await_revert().await;
        guard.stop().await;
    }

    /// One armed window per scope. A second apply supersedes the first, or two
    /// timers would race and the loser would restore a snapshot that is two
    /// changes stale.
    #[tokio::test]
    async fn a_second_apply_in_the_same_scope_supersedes_the_first() {
        let guard = RollbackGuard::new();
        let (first, second) = (RevertSpy::new(), RevertSpy::new());

        let first_token = guard.arm("firewall", 1, first.revert()).await.unwrap().unwrap();
        let second_token = guard.arm("firewall", 1, second.revert()).await.unwrap().unwrap();

        assert_ne!(
            first_token, second_token,
            "both applies were handed the same token"
        );
        assert_eq!(
            guard.armed_count(),
            1,
            "more than one revert is armed for one scope"
        );
        // The superseded token is dead, so a late confirm for the first apply
        // cannot cancel the second apply's window.
        assert!(
            is_not_found(&guard.confirm(&first_token).await),
            "the superseded token confirmed"
        );

        second.await_revert().await;
        assert_eq!(first.calls(), 0, "the superseded revert ran");
        guard.stop().await;
    }

    /// The firewall and sshd share one guard, and they must not cancel each
    /// other: confirming a firewall apply is not a statement about ssh.
    #[tokio::test]
    async fn scopes_are_independent() {
        let guard = RollbackGuard::new();
        let (firewall, ssh) = (RevertSpy::new(), RevertSpy::new());

        let firewall_token = guard
            .arm("firewall", 1, firewall.revert())
            .await
            .unwrap()
            .unwrap();
        let _ssh_token = guard.arm("ssh", 1, ssh.revert()).await.unwrap().unwrap();
        assert_eq!(guard.armed_count(), 2, "two scopes should hold two reverts");

        guard.confirm(&firewall_token).await.unwrap();

        // The ssh window was never confirmed, so it still lapses.
        ssh.await_revert().await;
        assert_eq!(firewall.calls(), 0, "the confirmed firewall change was reverted");
        guard.stop().await;
    }

    #[tokio::test]
    async fn stop_disarms_everything_at_shutdown() {
        let guard = RollbackGuard::new();
        let (firewall, ssh) = (RevertSpy::new(), RevertSpy::new());

        guard.arm("firewall", 1, firewall.revert()).await.unwrap();
        guard.arm("ssh", 1, ssh.revert()).await.unwrap();

        // Closing the provider means the agent is going away. Reverting on the
        // way out would undo a change during a routine restart.
        guard.stop().await;
        assert_eq!(guard.armed_count(), 0, "stop left armed reverts");
        firewall.assert_quiet(Duration::from_millis(1500)).await;
        assert_eq!(ssh.calls(), 0, "the ssh revert ran after stop");
    }

    /// A revert that fails is logged, not retried, and must not leave the
    /// token behind for a confirm to find.
    #[tokio::test]
    async fn a_failing_revert_still_clears_its_token() {
        let guard = RollbackGuard::new();
        let spy = RevertSpy::failing("nft is no longer installed");

        let token = guard.arm("firewall", 1, spy.revert()).await.unwrap().unwrap();
        spy.await_revert().await;

        // Give the timer task a moment past the send to finish unwinding.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < deadline {
            if is_not_found(&guard.confirm(&token).await) {
                guard.stop().await;
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("a failed revert left its token armed");
    }

    #[tokio::test]
    async fn tokens_are_unguessable() {
        let guard = RollbackGuard::new();
        let mut seen = std::collections::HashSet::new();

        for i in 0..32u8 {
            let scope = format!("scope{}", (b'a' + i) as char);
            let token = guard
                .arm(&scope, 60, Box::new(|| Box::pin(async { Ok(()) })))
                .await
                .unwrap()
                .unwrap();
            // 16 random bytes, hex-encoded. A short or repeating token would
            // let a caller confirm a window it never armed.
            assert_eq!(token.len(), 32, "token {token:?} has the wrong length");
            assert!(seen.insert(token.clone()), "token {token:?} was issued twice");
        }
        guard.stop().await;
    }
}
