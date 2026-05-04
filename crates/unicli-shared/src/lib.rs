use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: &str = "compute-sidecar.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SidecarRequest {
    pub id: u64,
    pub kind: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SidecarResponse {
    pub id: u64,
    pub kind: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SidecarError>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SidecarError {
    pub transport: String,
    pub action: String,
    pub reason: String,
    pub suggestion: String,
    pub minimum_capability: String,
    pub exit_code: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stable_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
}

impl SidecarResponse {
    pub fn ok(id: u64, kind: impl Into<String>, data: impl Into<Value>) -> Self {
        Self {
            id,
            kind: kind.into(),
            ok: true,
            data: Some(data.into()),
            error: None,
        }
    }

    pub fn error(
        id: u64,
        kind: impl Into<String>,
        transport: impl Into<String>,
        reason: impl Into<String>,
        suggestion: impl Into<String>,
        exit_code: u8,
    ) -> Self {
        let kind = kind.into();
        let transport = transport.into();
        Self {
            id,
            kind: kind.clone(),
            ok: false,
            data: None,
            error: Some(SidecarError {
                action: kind.clone(),
                minimum_capability: format!("{transport}.{kind}"),
                transport,
                reason: reason.into(),
                suggestion: suggestion.into(),
                exit_code,
                stable_token: None,
                r#ref: None,
            }),
        }
    }
}
