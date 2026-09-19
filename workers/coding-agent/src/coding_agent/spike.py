"""Phase 2 spike: prove the pinned openhands-sdk can edit a disposable repo end-to-end.

Not the production adapter (see ADR-0001) — this only exists to validate that
Agent/Conversation/Tool wiring against a real repo and a real LLM works before
building the internal execution request/result contract around it.

Usage:
    python -m coding_agent.spike /path/to/disposable/repo

Not tied to one provider: set LLM_MODEL to any LiteLLM-style model string
("anthropic/claude-sonnet-5", "openai/gpt-5", "gemini/gemini-3-pro",
"openrouter/...", "ollama/..." for a local model, etc). Reads the matching
credential from the environment, or from a .env file in this directory
(workers/coding-agent/.env — gitignored, never commit it; see .env.example).
LLM_API_KEY always overrides the provider-specific guess if set.

The target repo must already be a git checkout. Nothing here should ever point
at a real client repository or run outside a disposable workspace.
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from openhands.sdk import LLM, Agent, Conversation, Tool
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

DEFAULT_MODEL = "anthropic/claude-sonnet-5"

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

TASK = (
    "In this repository, add a function `add(a, b)` to src/math_utils.py that "
    "returns a + b. Add a test for it in test_math_utils.py using plain "
    "assert statements (no pytest dependency needed). Then run "
    "`python test_math_utils.py` with the terminal tool and confirm it exits "
    "zero before you finish."
)


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python -m coding_agent.spike /path/to/disposable/repo", file=sys.stderr)
        raise SystemExit(2)

    workspace = sys.argv[1]
    model = os.getenv("LLM_MODEL", DEFAULT_MODEL)
    api_key = resolve_api_key(model)
    provider = model.split("/", 1)[0]
    if not api_key and provider in PROVIDER_API_KEY_ENV:
        expected_env = PROVIDER_API_KEY_ENV[provider]
        print(
            f"No credential found for provider '{provider}'. Set LLM_API_KEY, "
            f"or {expected_env}, in the environment or in .env.",
            file=sys.stderr,
        )
        raise SystemExit(2)

    llm = LLM(model=model, api_key=api_key)
    agent = Agent(
        llm=llm,
        tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)],
    )
    conversation = Conversation(agent=agent, workspace=workspace)
    conversation.send_message(TASK)
    conversation.run()

    print("\n--- conversation finished, diffing workspace ---\n")
    os.system(f'git -C "{workspace}" --no-pager diff')


if __name__ == "__main__":
    main()
