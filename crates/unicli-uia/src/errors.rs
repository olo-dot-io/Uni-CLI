use serde_json::Value;
use unicli_shared::{SidecarError, SidecarResponse};

pub type HandlerResult = Result<Value, UiaError>;

#[derive(Debug, Clone)]
pub struct UiaError {
    reason: String,
    suggestion: String,
    minimum_capability: Option<String>,
    r#ref: Option<String>,
    exit_code: u8,
}

impl UiaError {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            suggestion: "run on Windows with the native UIA backend available, or fall back to CUA"
                .into(),
            minimum_capability: None,
            r#ref: None,
            exit_code: 69,
        }
    }

    pub fn invalid_input(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            suggestion: "check the compute command arguments and retry".into(),
            minimum_capability: Some("desktop-uia.invalid_input".into()),
            r#ref: None,
            exit_code: 78,
        }
    }

    #[allow(dead_code)] // Used by native Windows UIA handlers.
    pub fn no_element(r#ref: impl Into<String>) -> Self {
        let r#ref = r#ref.into();
        Self {
            reason: format!("no UIA element matched {ref}"),
            suggestion: "re-snapshot; the ref may be stale".into(),
            minimum_capability: Some("desktop-uia.no_element".into()),
            r#ref: Some(r#ref),
            exit_code: 66,
        }
    }

    #[allow(dead_code)] // Used by native Windows UIA handlers.
    pub fn not_invokable(r#ref: impl Into<String>) -> Self {
        let r#ref = r#ref.into();
        Self {
            reason: format!("UIA element {ref} does not expose Invoke"),
            suggestion: "try set-value, press, or focus before retrying".into(),
            minimum_capability: Some("desktop-uia.not_invokable".into()),
            r#ref: Some(r#ref),
            exit_code: 69,
        }
    }

    #[allow(dead_code)] // Used by the native Windows UIA handlers for UIAccess failures.
    pub fn permission(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            suggestion: "grant UIAccess or run from an elevated terminal".into(),
            minimum_capability: Some("desktop-uia.permission".into()),
            r#ref: None,
            exit_code: 77,
        }
    }

    #[allow(dead_code)] // Used by the native Windows UIA handlers for bounded polls.
    pub fn timeout(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            suggestion: "retry the command; run UNICLI_TRACE=1 unicli doctor compute if it repeats"
                .into(),
            minimum_capability: Some("desktop-uia.timeout".into()),
            r#ref: None,
            exit_code: 75,
        }
    }
}

pub trait IntoSidecarResponse {
    fn into_response(self, id: u64, kind: String) -> SidecarResponse;
}

impl IntoSidecarResponse for HandlerResult {
    fn into_response(self, id: u64, kind: String) -> SidecarResponse {
        match self {
            Ok(data) => SidecarResponse::ok(id, kind, data),
            Err(err) => {
                let minimum_capability = err
                    .minimum_capability
                    .unwrap_or_else(|| format!("desktop-uia.{kind}"));
                SidecarResponse {
                    id,
                    kind: kind.clone(),
                    ok: false,
                    data: None,
                    error: Some(SidecarError {
                        transport: "desktop-uia".into(),
                        action: kind,
                        reason: err.reason,
                        suggestion: err.suggestion,
                        minimum_capability,
                        exit_code: err.exit_code,
                        stable_token: None,
                        r#ref: err.r#ref,
                    }),
                }
            }
        }
    }
}

pub fn backend_unavailable() -> UiaError {
    if cfg!(target_os = "windows") {
        UiaError::unavailable(backend_unavailable_reason("windows"))
    } else {
        UiaError::unavailable(backend_unavailable_reason(std::env::consts::OS))
    }
}

fn backend_unavailable_reason(target_os: &str) -> String {
    if target_os == "windows" {
        "Windows UIA backend is unavailable for this request".into()
    } else {
        format!("desktop-uia is only available on Windows; current target is {target_os}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error_for(err: UiaError) -> unicli_shared::SidecarError {
        let response = Err::<Value, _>(err).into_response(7, "uia_invoke".into());
        response.error.expect("error response")
    }

    #[test]
    fn no_element_uses_semantic_minimum_capability() {
        let error = error_for(UiaError::no_element("@e42"));
        assert_eq!(error.minimum_capability, "desktop-uia.no_element");
        assert_eq!(error.r#ref.as_deref(), Some("@e42"));
        assert_eq!(error.exit_code, 66);
    }

    #[test]
    fn not_invokable_uses_semantic_minimum_capability() {
        let error = error_for(UiaError::not_invokable("@e42"));
        assert_eq!(error.minimum_capability, "desktop-uia.not_invokable");
        assert_eq!(error.r#ref.as_deref(), Some("@e42"));
    }

    #[test]
    fn permission_uses_semantic_minimum_capability() {
        let error = error_for(UiaError::permission("access denied"));
        assert_eq!(error.minimum_capability, "desktop-uia.permission");
        assert_eq!(error.exit_code, 77);
    }

    #[test]
    fn timeout_uses_semantic_minimum_capability() {
        let error = error_for(UiaError::timeout("UIA request timed out"));
        assert_eq!(error.minimum_capability, "desktop-uia.timeout");
        assert_eq!(error.exit_code, 75);
    }

    #[test]
    fn backend_unavailable_reason_does_not_claim_native_traversal_pending() {
        let reason = backend_unavailable_reason("windows");

        assert!(!reason.contains("pending"));
        assert!(reason.contains("unavailable"));
    }
}
