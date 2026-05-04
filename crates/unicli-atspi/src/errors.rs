use serde_json::Value;
use unicli_shared::{SidecarError, SidecarResponse};

pub type HandlerResult = Result<Value, AtspiError>;

#[derive(Debug, Clone)]
pub struct AtspiError {
    reason: String,
    suggestion: String,
    minimum_capability: Option<String>,
    r#ref: Option<String>,
    exit_code: u8,
}

impl AtspiError {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            suggestion:
                "run on Linux with the native AT-SPI backend available, or fall back to CUA".into(),
            minimum_capability: None,
            r#ref: None,
            exit_code: 69,
        }
    }

    pub fn invalid_input(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            suggestion:
                "pass a desktop-atspi stable top-level window ref from atspi_snapshot or atspi_find"
                    .into(),
            minimum_capability: Some("desktop-atspi.invalid_input".into()),
            r#ref: None,
            exit_code: 78,
        }
    }

    #[allow(dead_code)] // Used by native Linux AT-SPI handlers.
    pub fn no_element(r#ref: impl Into<String>) -> Self {
        let r#ref = r#ref.into();
        Self {
            reason: format!("no AT-SPI element matched {ref}"),
            suggestion: "re-snapshot; the ref may be stale".into(),
            minimum_capability: Some("desktop-atspi.no_element".into()),
            r#ref: Some(r#ref),
            exit_code: 66,
        }
    }

    pub fn not_invokable(r#ref: impl Into<String>) -> Self {
        let r#ref = r#ref.into();
        Self {
            reason: format!("AT-SPI element {ref} does not expose a native action"),
            suggestion: "try CUA fallback, set-value, press, or focus before retrying".into(),
            minimum_capability: Some("desktop-atspi.not_invokable".into()),
            r#ref: Some(r#ref),
            exit_code: 69,
        }
    }

    #[allow(dead_code)] // Used by the native Linux AT-SPI connection path.
    pub fn dbus_blocked(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            suggestion: "start the user AT-SPI D-Bus daemon".into(),
            minimum_capability: Some("desktop-atspi.dbus_blocked".into()),
            r#ref: None,
            exit_code: 69,
        }
    }

    #[allow(dead_code)] // Used when a target app exposes no useful AT-SPI tree.
    pub fn no_a11y_attr(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            suggestion: "enable accessibility support for the target app".into(),
            minimum_capability: Some("desktop-atspi.no_a11y_attr".into()),
            r#ref: None,
            exit_code: 69,
        }
    }

    #[allow(dead_code)] // Used by Wayland fallback input dispatch.
    pub fn wayland_input_missing(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            suggestion: "install ydotool or another supported Wayland input helper".into(),
            minimum_capability: Some("desktop-atspi.wayland-input".into()),
            r#ref: None,
            exit_code: 69,
        }
    }

    #[allow(dead_code)] // Used by X11 fallback input dispatch.
    pub fn x11_input_missing(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            suggestion: "install xdotool for X11 fallback input".into(),
            minimum_capability: Some("desktop-atspi.x11-input".into()),
            r#ref: None,
            exit_code: 69,
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
                    .unwrap_or_else(|| format!("desktop-atspi.{kind}"));
                SidecarResponse {
                    id,
                    kind: kind.clone(),
                    ok: false,
                    data: None,
                    error: Some(SidecarError {
                        transport: "desktop-atspi".into(),
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

pub fn backend_unavailable() -> AtspiError {
    if cfg!(target_os = "linux") {
        AtspiError::unavailable(backend_unavailable_reason("linux"))
    } else {
        AtspiError::unavailable(backend_unavailable_reason(std::env::consts::OS))
    }
}

fn backend_unavailable_reason(target_os: &str) -> String {
    if target_os == "linux" {
        "Linux AT-SPI backend is unavailable for this request".into()
    } else {
        format!("desktop-atspi is only available on Linux; current target is {target_os}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error_for(err: AtspiError) -> unicli_shared::SidecarError {
        let response = Err::<Value, _>(err).into_response(9, "atspi_invoke".into());
        response.error.expect("error response")
    }

    #[test]
    fn no_element_uses_semantic_minimum_capability() {
        let error = error_for(AtspiError::no_element("@e42"));
        assert_eq!(error.minimum_capability, "desktop-atspi.no_element");
        assert_eq!(error.r#ref.as_deref(), Some("@e42"));
        assert_eq!(error.exit_code, 66);
    }

    #[test]
    fn not_invokable_uses_semantic_minimum_capability() {
        let error = error_for(AtspiError::not_invokable("@e42"));
        assert_eq!(error.minimum_capability, "desktop-atspi.not_invokable");
        assert_eq!(error.r#ref.as_deref(), Some("@e42"));
        assert_eq!(error.exit_code, 69);
    }

    #[test]
    fn dbus_blocked_uses_semantic_minimum_capability() {
        let error = error_for(AtspiError::dbus_blocked("AT-SPI D-Bus is unavailable"));
        assert_eq!(error.minimum_capability, "desktop-atspi.dbus_blocked");
        assert_eq!(error.exit_code, 69);
    }

    #[test]
    fn wayland_input_uses_semantic_minimum_capability() {
        let error = error_for(AtspiError::wayland_input_missing("ydotool is missing"));
        assert_eq!(error.minimum_capability, "desktop-atspi.wayland-input");
    }

    #[test]
    fn no_a11y_attr_uses_semantic_minimum_capability() {
        let error = error_for(AtspiError::no_a11y_attr("no accessibility attributes"));
        assert_eq!(error.minimum_capability, "desktop-atspi.no_a11y_attr");
    }

    #[test]
    fn x11_input_uses_semantic_minimum_capability() {
        let error = error_for(AtspiError::x11_input_missing("xdotool is missing"));
        assert_eq!(error.minimum_capability, "desktop-atspi.x11-input");
    }

    #[test]
    fn backend_unavailable_reason_does_not_claim_native_traversal_pending() {
        let reason = backend_unavailable_reason("linux");

        assert!(!reason.contains("pending"));
        assert!(reason.contains("unavailable"));
    }
}
