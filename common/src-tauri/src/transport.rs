#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransportMode {
    Development,
    Release,
}

impl TransportMode {
    pub(crate) fn from_value(value: &str) -> Self {
        Self::try_from_value(value).unwrap_or(Self::Development)
    }

    pub(crate) fn try_from_value(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "development" | "dev" | "" => Ok(Self::Development),
            "release" => Ok(Self::Release),
            other => Err(format!("unsupported BLINKY_TRANSPORT_MODE: {other}")),
        }
    }

    pub(crate) fn current() -> Self {
        Self::from_value(env!("BLINKY_TRANSPORT_MODE"))
    }

    pub(crate) fn is_release(self) -> bool {
        matches!(self, Self::Release)
    }
}

pub(crate) fn remote_auth_required(
    _mode: TransportMode,
    is_loopback: bool,
    _has_configured_token: bool,
) -> bool {
    // Fail-closed BYOK default: every non-loopback peer must present
    // BLINKY_REMOTE_TOKEN, in development and release alike. An unset token
    // means remote peers cannot authenticate (pair via QR to configure one).
    !is_loopback
}

#[cfg(test)]
mod tests {
    use super::{remote_auth_required, TransportMode};

    #[test]
    fn release_mode_is_selected_explicitly() {
        assert_eq!(TransportMode::from_value("release"), TransportMode::Release);
        assert_eq!(
            TransportMode::from_value("development"),
            TransportMode::Development
        );
    }

    #[test]
    fn unknown_transport_mode_is_rejected() {
        assert!(TransportMode::try_from_value("staging").is_err());
    }

    #[test]
    fn release_requires_remote_auth_even_without_a_configured_token() {
        assert!(remote_auth_required(TransportMode::Release, false, false));
    }

    #[test]
    fn development_requires_remote_auth_even_without_a_configured_token() {
        assert!(remote_auth_required(TransportMode::Development, false, false));
        assert!(remote_auth_required(TransportMode::Development, false, true));
    }

    #[test]
    fn loopback_does_not_require_remote_auth() {
        assert!(!remote_auth_required(TransportMode::Release, true, false));
    }
}
