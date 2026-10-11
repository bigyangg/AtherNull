"""Builds in the org sandbox use what the workspace owner configured in the
canvas — MCP servers (connectors), skills, installed plugins — and present
the agent as the AtherNull Agent."""

import os

os.environ.setdefault("WORKER_ID", "test-worker")
os.environ.setdefault("ATHERNULL_API_URL", "http://localhost:3001")
os.environ.setdefault("INTERNAL_API_TOKEN", "test-token")

import json

import httpx

from coding_agent.org_sandbox_adapter import AGENT_IDENTITY, build_title, workspace_agent_setup


def sandbox(settings: dict, skills: list | None = None, plugins: list | None = None, fail: bool = False):
    seen: list[tuple[str, str, dict | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        seen.append((request.method, request.url.path, body))
        if fail:
            return httpx.Response(500, json={"detail": "down"})
        if request.url.path == "/api/settings":
            return httpx.Response(200, json=settings)
        if request.url.path == "/api/skills":
            return httpx.Response(200, json={"skills": skills or [], "sources": {}})
        if request.url.path == "/api/plugins/installed":
            return httpx.Response(200, json={"plugins": plugins or []})
        return httpx.Response(404)

    return httpx.Client(base_url="http://sandbox", transport=httpx.MockTransport(handler)), seen


def test_connectors_skills_and_plugins_reach_the_build():
    http, seen = sandbox(
        {
            "agent_settings": {"mcp_config": {"mcpServers": {"linear": {"url": "https://mcp.linear.app/sse"}}}},
            "misc_settings": {"app_preferences": {"enabled_skills": ["codereview"], "disabled_skills": ["noisy"]}},
        },
        skills=[
            {"name": "codereview", "content": "Review carefully.", "source": "registry", "triggers": []},
            {"name": "not-enabled", "content": "x"},
        ],
        plugins=[
            {"name": "pr-review", "source": "github:acme/pr-review", "resolved_ref": "abc123", "enabled": True},
            {"name": "off", "source": "github:acme/off", "enabled": False},
        ],
    )
    mcp, context, plugins = workspace_agent_setup(http)
    assert mcp == {"mcpServers": {"linear": {"url": "https://mcp.linear.app/sse"}}}
    assert [s["name"] for s in context["skills"]] == ["codereview"]
    assert "triggers" not in context["skills"][0]
    assert context["disabled_skills"] == ["noisy"]
    assert context["load_user_skills"] and context["load_project_skills"] and not context["load_public_skills"]
    assert context["system_message_suffix"] == AGENT_IDENTITY
    assert plugins == [{"source": "github:acme/pr-review", "ref": "abc123"}]
    assert ("POST", "/api/skills") in [(m, p) for m, p, _ in seen]


def test_no_catalog_lookup_without_enabled_skills():
    http, seen = sandbox({"agent_settings": {"mcp_config": {}}, "misc_settings": {"app_preferences": {}}})
    mcp, context, plugins = workspace_agent_setup(http)
    assert mcp == {} and context["skills"] == [] and plugins == []
    assert "/api/skills" not in [p for _, p, _ in seen]


def test_an_unreachable_setup_still_lets_the_build_run():
    http, _ = sandbox({}, fail=True)
    mcp, context, plugins = workspace_agent_setup(http)
    assert mcp == {} and plugins == []
    assert context["system_message_suffix"] == AGENT_IDENTITY


def test_identity_is_athernull():
    assert "AtherNull Agent" in AGENT_IDENTITY
    assert "Never call yourself OpenHands" in AGENT_IDENTITY


def test_build_title_is_the_objective_first_line():
    assert build_title("Add GET /version\nwith tests") == "Add GET /version"
    assert len(build_title("y" * 200)) == 60
    assert build_title("  \n ") == "Build"


def test_switched_off_connectors_and_platform_skills_stay_out():
    http, _ = sandbox(
        {
            "agent_settings": {"mcp_config": {"on": {"url": "https://a/sse"}, "off": {"url": "https://b/sse", "enabled": False}}},
            "misc_settings": {"app_preferences": {"enabled_skills": ["code-review", "openhands-sdk", "agent-sdk-builder"]}},
        },
        skills=[
            {"name": "code-review", "content": "Review."},
            {"name": "openhands-sdk", "content": "SDK reference."},
            {"name": "agent-sdk-builder", "content": "x", "description": "Build agents with the OpenHands Software Agent SDK."},
        ],
    )
    mcp, context, _ = workspace_agent_setup(http)
    assert list(mcp) == ["on"]
    assert [s["name"] for s in context["skills"]] == ["code-review"]
