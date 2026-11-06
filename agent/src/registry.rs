//! Method registry.
//!
//! This map IS the agent's attack surface. Every entry is an enumerated verb
//! with a typed parameter struct; there is no dynamic dispatch by string from
//! user input and no verb that accepts a shell command. A name that is not in
//! this map is answered with `unknown_method` before any provider sees it.

use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::providers::{Ctx, StreamRef};
use crate::wire::{ErrorCode, WireError};

/// A method's chunk traffic, mirroring the contract's StreamMode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamMode {
    None,
    Response,
    Bidirectional,
}

impl StreamMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "none" => Some(StreamMode::None),
            "response" => Some(StreamMode::Response),
            "bidirectional" => Some(StreamMode::Bidirectional),
            _ => None,
        }
    }
}

/// One inbound call. `stream` is present exactly when the method's mode is
/// not `None`.
pub struct Request {
    pub id: String,
    pub method: String,
    pub params: Option<Value>,
    pub stream: Option<StreamRef>,
}

pub type HandlerFuture = Pin<Box<dyn Future<Output = Result<Value, WireError>> + Send>>;
pub type Handler = Arc<dyn Fn(Ctx, Request) -> HandlerFuture + Send + Sync>;

/// A registered verb.
#[derive(Clone)]
pub struct Method {
    pub name: &'static str,
    pub mode: StreamMode,
    /// Host capabilities, any one of which admits the call. Empty means every
    /// host can serve it.
    pub requires: &'static [&'static str],
    pub handler: Handler,
}

/// Answers "can this host serve this method at all", using the same
/// capability set the agent advertised in its hello frame. Failing here is
/// what turns a missing daemon into a fast `unsupported` instead of a
/// confusing exec failure deep in a provider.
#[derive(Clone, Debug, Default)]
pub struct CapabilityGate {
    have: HashSet<String>,
}

impl CapabilityGate {
    pub fn new(capabilities: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            have: capabilities.into_iter().map(Into::into).collect(),
        }
    }

    pub fn has(&self, capability: &str) -> bool {
        self.have.contains(capability)
    }

    /// Whether any one of the required capabilities is present. An empty
    /// requirement list always passes.
    pub fn allows(&self, required: &[&str]) -> bool {
        required.is_empty() || required.iter().any(|c| self.has(c))
    }
}

pub struct Registry {
    methods: BTreeMap<&'static str, Method>,
    gate: CapabilityGate,
}

impl Registry {
    pub fn new(gate: CapabilityGate) -> Self {
        Self {
            methods: BTreeMap::new(),
            gate,
        }
    }

    /// Adds a verb. A duplicate name panics, because two handlers for one
    /// method name is a build-time mistake.
    pub fn register(&mut self, method: Method) {
        if self.methods.contains_key(method.name) {
            panic!("rpc: method registered twice: {}", method.name);
        }
        self.methods.insert(method.name, method);
    }

    /// Looks a method up and gates it on host capabilities.
    pub fn resolve(&self, name: &str) -> Result<&Method, WireError> {
        let method = self
            .methods
            .get(name)
            .ok_or_else(|| WireError::new(ErrorCode::UnknownMethod, format!("no such method: {name}")))?;
        if !self.gate.allows(method.requires) {
            return Err(WireError::new(
                ErrorCode::Unsupported,
                format!("host does not provide {}", join_or(method.requires)),
            ));
        }
        Ok(method)
    }

    /// Every registered method, sorted.
    pub fn names(&self) -> Vec<&'static str> {
        self.methods.keys().copied().collect()
    }

    pub fn get(&self, name: &str) -> Option<&Method> {
        self.methods.get(name)
    }

    pub fn len(&self) -> usize {
        self.methods.len()
    }

    pub fn is_empty(&self) -> bool {
        self.methods.is_empty()
    }
}

impl std::fmt::Debug for Method {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Method")
            .field("name", &self.name)
            .field("mode", &self.mode)
            .field("requires", &self.requires)
            .finish_non_exhaustive()
    }
}

fn join_or(items: &[&str]) -> String {
    match items {
        [] => "anything".to_string(),
        [one] => one.to_string(),
        many => many.join(" or "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noop() -> Handler {
        Arc::new(|_ctx, _req| Box::pin(async { Ok(Value::Null) }))
    }

    #[test]
    fn unknown_methods_and_missing_capabilities_are_distinct_errors() {
        let mut r = Registry::new(CapabilityGate::new(["systemd"]));
        r.register(Method {
            name: "service.list",
            mode: StreamMode::None,
            requires: &["systemd"],
            handler: noop(),
        });
        r.register(Method {
            name: "container.list",
            mode: StreamMode::None,
            requires: &["docker", "podman"],
            handler: noop(),
        });
        assert!(r.resolve("service.list").is_ok());
        assert_eq!(r.resolve("nope").unwrap_err().code, ErrorCode::UnknownMethod);
        let err = r.resolve("container.list").unwrap_err();
        assert_eq!(err.code, ErrorCode::Unsupported);
        assert!(err.message.contains("docker or podman"));
    }

    #[test]
    #[should_panic(expected = "registered twice")]
    fn a_duplicate_registration_is_a_programming_error() {
        let mut r = Registry::new(CapabilityGate::default());
        let m = Method {
            name: "x",
            mode: StreamMode::None,
            requires: &[],
            handler: noop(),
        };
        r.register(m.clone());
        r.register(m);
    }
}
