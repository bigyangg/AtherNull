"""LLM credential resolution, shared by spike.py and worker.py.

Not tied to one provider: any LiteLLM-style model string works
("anthropic/claude-sonnet-5", "openai/gpt-5", "nvidia_nim/...", "ollama/..."
for a local model needing no key, etc). LLM_API_KEY always overrides the
provider-specific guess if set.
"""

import os

# Providers that need a key, mapped to the env var LiteLLM/OpenHands expect it
# under. Extend this as we onboard providers — it's a lookup table, not policy.
PROVIDER_API_KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "azure": "AZURE_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "vertex_ai": "GOOGLE_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "groq": "GROQ_API_KEY",
    "mistral": "MISTRAL_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "together_ai": "TOGETHER_API_KEY",
    "fireworks_ai": "FIREWORKS_API_KEY",
    # NVIDIA Build / NIM: OpenAI-compatible catalog at integrate.api.nvidia.com.
    # LiteLLM's "nvidia_nim/<model>" prefix routes there automatically —
    # no api_base override needed for the default hosted endpoint.
    "nvidia_nim": "NVIDIA_NIM_API_KEY",
    # "ollama" and other local runtimes intentionally omitted: no key needed.
}


def resolve_api_key(model: str) -> str | None:
    """LLM_API_KEY always wins; otherwise look up the provider prefix in
    PROVIDER_API_KEY_ENV. A provider not in the table (e.g. a local runtime)
    is assumed not to need a key rather than treated as an error."""
    override = os.getenv("LLM_API_KEY")
    if override:
        return override
    provider = model.split("/", 1)[0]
    env_var = PROVIDER_API_KEY_ENV.get(provider)
    return os.getenv(env_var) if env_var else None


class MissingCredentialError(RuntimeError):
    pass


def require_api_key(model: str) -> str | None:
    """Same lookup as resolve_api_key, but raises with a clear message when
    the provider is known to need a key and none was found — used by callers
    that can't just print-and-exit(2) like spike.py does."""
    api_key = resolve_api_key(model)
    provider = model.split("/", 1)[0]
    if not api_key and provider in PROVIDER_API_KEY_ENV:
        expected_env = PROVIDER_API_KEY_ENV[provider]
        raise MissingCredentialError(
            f"No credential found for provider '{provider}'. Set LLM_API_KEY, "
            f"or {expected_env}, in the environment or in .env."
        )
    return api_key
