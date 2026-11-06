//! Deterministic fake host (stub until the port lands).
use super::{Options, ProviderRef};

pub async fn open(_opts: Options) -> anyhow::Result<ProviderRef> {
    anyhow::bail!("sim provider not yet ported")
}
