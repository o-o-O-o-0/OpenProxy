pub const API_KEY_PREFIX: &str = "op-";
const LEGACY_API_KEY_PREFIX: &str = "openproxy-";

pub fn migrate_api_key_value(api_key: &str) -> Option<String> {
    api_key
        .strip_prefix(LEGACY_API_KEY_PREFIX)
        .map(|suffix| format!("{}{}", API_KEY_PREFIX, suffix))
}

#[cfg(test)]
mod tests {
    use super::migrate_api_key_value;

    #[test]
    fn migrates_legacy_api_key_prefix() {
        assert_eq!(
            migrate_api_key_value("openproxy-abc123"),
            Some("op-abc123".to_string())
        );
    }

    #[test]
    fn leaves_new_api_key_prefix_unchanged() {
        assert_eq!(migrate_api_key_value("op-abc123"), None);
    }
}
