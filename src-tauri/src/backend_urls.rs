pub fn strip_anthropic_endpoint_suffix(url: &str) -> String {
    let url = url.trim().trim_end_matches('/');
    url.replace("/chat/completions", "")
        .replace("/models", "")
        .replace("/v1/messages", "")
        .replace("/messages", "")
        .replace("/v1", "")
}

pub fn derive_anthropic_candidates(base_url: &str) -> Vec<String> {
    let cleaned = strip_anthropic_endpoint_suffix(base_url);
    vec![format!("{}/v1/messages", cleaned)]
}

pub fn derive_openai_model_candidates(base_url: &str) -> Vec<String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        vec![
            format!("{}/models", trimmed),
            format!("{}/models", trimmed.trim_end_matches("/v1")),
        ]
    } else {
        vec![
            format!("{}/v1/models", trimmed),
            format!("{}/models", trimmed),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::derive_anthropic_candidates;

    #[test]
    fn derives_anthropic_endpoint_from_openai_chat_url() {
        assert_eq!(
            derive_anthropic_candidates("https://opencode.ai/zen/v1/chat/completions"),
            vec!["https://opencode.ai/zen/v1/messages".to_string()]
        );
    }
}
