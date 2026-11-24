import { afterEach, describe, it, expect, vi } from "vitest";
import {
  extractPrsFromAttachments,
  GqlAttachmentNode,
  LinearService,
  projectFilter,
} from "./linear";

describe("extractPrsFromAttachments", () => {
  it("returns an empty array for empty attachments", () => {
    expect(extractPrsFromAttachments([])).toEqual([]);
  });

  it("returns an empty array when no attachment has a PR URL", () => {
    const attachments: GqlAttachmentNode[] = [
      { url: "https://example.com/some-page", title: "Docs" },
      { url: "https://github.com/org/repo/issues/42", title: "Issue" },
    ];
    expect(extractPrsFromAttachments(attachments)).toEqual([]);
  });

  it("extracts PR info from a GitHub PR URL", () => {
    const attachments: GqlAttachmentNode[] = [
      { url: "https://github.com/org/repo/pull/123", title: "Fix bug" },
    ];
    expect(extractPrsFromAttachments(attachments)).toEqual([
      {
        url: "https://github.com/org/repo/pull/123",
        title: "Fix bug",
        state: "open",
        number: 123,
        repoSlug: "org/repo",
      },
    ]);
  });

  it("uses a fallback title when attachment has no title", () => {
    const attachments: GqlAttachmentNode[] = [{ url: "https://github.com/org/repo/pull/7" }];
    expect(extractPrsFromAttachments(attachments)[0]?.title).toBe("PR #7");
  });

  it("detects merged state from metadata object", () => {
    const attachments: GqlAttachmentNode[] = [
      {
        url: "https://github.com/org/repo/pull/10",
        title: "Feature",
        metadata: { status: "Merged" },
      },
    ];
    expect(extractPrsFromAttachments(attachments)[0]?.state).toBe("merged");
  });

  it("detects merged state from JSON string metadata", () => {
    const attachments: GqlAttachmentNode[] = [
      {
        url: "https://github.com/org/repo/pull/10",
        title: "Feature",
        metadata: JSON.stringify({ state: "MERGED" }),
      },
    ];
    expect(extractPrsFromAttachments(attachments)[0]?.state).toBe("merged");
  });

  it.each(["null", "42", '"merged"', "[]", '{"status": 42}'])(
    "ignores non-status metadata: %s",
    (metadata) => {
      expect(
        extractPrsFromAttachments([{ url: "https://github.com/org/repo/pull/1", metadata }])[0]
          ?.state
      ).toBe("open");
    }
  );

  it("detects closed state from metadata", () => {
    const attachments: GqlAttachmentNode[] = [
      {
        url: "https://github.com/org/repo/pull/5",
        title: "Abandoned",
        metadata: { status: "Closed" },
      },
    ];
    expect(extractPrsFromAttachments(attachments)[0]?.state).toBe("closed");
  });

  it("falls back to subtitle for merged detection when metadata has no state", () => {
    const attachments: GqlAttachmentNode[] = [
      {
        url: "https://github.com/org/repo/pull/20",
        title: "Done",
        subtitle: "Merged by user",
      },
    ];
    expect(extractPrsFromAttachments(attachments)[0]?.state).toBe("merged");
  });

  it("falls back to subtitle for closed detection", () => {
    const attachments: GqlAttachmentNode[] = [
      {
        url: "https://github.com/org/repo/pull/21",
        title: "Nope",
        subtitle: "Closed without merge",
      },
    ];
    expect(extractPrsFromAttachments(attachments)[0]?.state).toBe("closed");
  });

  it.each([[{ status: "open", draft: true }], [JSON.stringify({ status: "Draft" })]])(
    "detects draft state from metadata %j",
    (metadata) => {
      expect(
        extractPrsFromAttachments([{ url: "https://github.com/org/repo/pull/1", metadata }])[0]
          ?.state
      ).toBe("draft");
    }
  );

  it("prefers merged over draft when both are present", () => {
    const metadata = { status: "merged", draft: true };
    expect(
      extractPrsFromAttachments([{ url: "https://github.com/org/repo/pull/1", metadata }])[0]?.state
    ).toBe("merged");
  });

  it("returns all PRs when multiple attachments have PR URLs", () => {
    const attachments: GqlAttachmentNode[] = [
      { url: "https://example.com/docs" },
      { url: "https://github.com/org/repo-a/pull/1", title: "First" },
      { url: "https://github.com/org/repo-b/pull/2", title: "Second" },
    ];
    const result = extractPrsFromAttachments(attachments);
    expect(result.map((p) => p.number)).toEqual([1, 2]);
    expect(result.map((p) => p.repoSlug)).toEqual(["org/repo-a", "org/repo-b"]);
  });

  it("dedupes attachments pointing at the same PR", () => {
    const attachments: GqlAttachmentNode[] = [
      { url: "https://github.com/org/repo/pull/1", title: "First" },
      { url: "https://github.com/Org/Repo/pull/1", title: "Duplicate" },
    ];
    expect(extractPrsFromAttachments(attachments)).toHaveLength(1);
  });

  it("skips attachments with no url", () => {
    const attachments: GqlAttachmentNode[] = [
      { title: "No URL" },
      { url: "https://github.com/org/repo/pull/99", title: "Has URL" },
    ];
    expect(extractPrsFromAttachments(attachments)[0]?.number).toBe(99);
  });
});

it("loads projects in bounded batches and preserves successful batches on failure", async () => {
  const service = new LinearService("test-key");
  const request = vi.fn(
    async (_query: string, variables: { filter: { id: { in: string[] } } }) => ({
      data: {
        issues: {
          nodes: variables.filter.id.in.map((id: string) => ({
            id,
            project: { id: "project", name: "API" },
            state: null,
            attachments: { nodes: [] },
          })),
        },
      },
    })
  );
  Object.defineProperty(service, "gql", { value: { rawRequest: request } });
  const ids = Array.from({ length: 101 }, (_, index) => `issue-${index}`);
  const result = await service.fetchIssueLinearInfoBatch(ids);
  expect(request.mock.calls.map((call) => call[1].filter.id.in.length)).toEqual([50, 50, 1]);
  expect(Object.keys(result)).toHaveLength(101);
  expect(result["issue-100"].project).toEqual({ id: "project", name: "API" });
  request.mockRejectedValueOnce(new Error("offline"));
  const partial = await service.fetchIssueLinearInfoBatch(ids);
  expect(Object.keys(partial)).toHaveLength(51);
  expect(partial["issue-0"]).toBeUndefined();
});

it("creates an assigned issue with nested data returned by the mutation", async () => {
  const service = new LinearService("test-key");
  const issue = {
    id: "issue",
    identifier: "WOR-1",
    title: "New thing",
    branchName: "me/wor-1-new-thing",
    description: "Details",
    priority: 0,
    updatedAt: "2026-10-04T00:00:00.000Z",
    project: { id: "project", name: "App" },
    state: { name: "Todo", type: "unstarted" },
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: { viewer: { id: "viewer" } } })
    .mockResolvedValueOnce({ data: { issueCreate: { success: true, issue } } });
  Object.defineProperty(service, "gql", { value: { rawRequest: request } });
  await expect(
    service.createIssue({ teamId: "team", title: "New thing", description: "Details" })
  ).resolves.toEqual({
    id: "issue",
    identifier: "WOR-1",
    title: "New thing",
    branchName: "me/wor-1-new-thing",
    description: "Details",
    priority: 0,
    updatedAt: issue.updatedAt,
    projectId: "project",
    projectName: "App",
    stateName: "Todo",
    stateType: "unstarted",
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenLastCalledWith(expect.stringContaining("mutation CreateIssue"), {
    input: { teamId: "team", title: "New thing", description: "Details", assigneeId: "viewer" },
  });
});

it.each([
  { success: false, issue: null },
  { success: true, issue: null },
])("rejects unsuccessful creation payloads: %j", async (payload) => {
  const service = new LinearService("test-key");
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: { viewer: { id: "viewer" } } })
    .mockResolvedValueOnce({ data: { issueCreate: payload } });
  Object.defineProperty(service, "gql", { value: { rawRequest: request } });
  await expect(service.createIssue({ teamId: "team", title: "New thing" })).rejects.toThrow(
    "Linear rejected the issue creation"
  );
});

describe("Linear issue suggestions", () => {
  const me = { isMe: { eq: true } };
  const filters = [
    { assignee: me },
    { creator: me },
    { project: { lead: me } },
    { project: { members: { some: me } } },
    { project: { creator: me } },
  ];
  const node = (id: string, priority = 0, updatedAt = "2026-10-01T00:00:00Z") => ({
    id,
    identifier: id,
    title: id,
    branchName: id,
    description: null,
    priority,
    updatedAt,
    project: { id: "project", name: "App" },
    state: { name: "Todo", type: "unstarted" },
  });
  const page = (nodes: ReturnType<typeof node>[], next: string | null = null) => ({
    nodes,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
  });
  const setup = () => {
    const service = new LinearService("test-key");
    const request = vi.fn();
    Object.defineProperty(service, "gql", { value: { rawRequest: request } });
    return { service, request };
  };

  it("orders all five groups by relevance, then urgency, and keeps overlaps in the first group", async () => {
    const { service, request } = setup();
    for (const [index] of filters.entries()) {
      request.mockResolvedValueOnce({
        data: {
          issues: page([
            node(`${index}-none`),
            node(`${index}-low`, 4),
            node(`${index}-medium`, 3),
            node(`${index}-high`, 2),
            node(`${index}-urgent`, 1),
            node("overlap", 2),
          ]),
        },
      });
    }
    const issues = await service.fetchSuggestedIssues();
    expect(issues.map((issue) => issue.id)).toEqual(
      filters.flatMap((_, index) => [
        `${index}-urgent`,
        `${index}-high`,
        ...(index === 0 ? ["overlap"] : []),
        `${index}-medium`,
        `${index}-low`,
        `${index}-none`,
      ])
    );
    expect(issues[0]).toMatchObject({
      projectId: "project",
      projectName: "App",
      stateName: "Todo",
    });
    expect(request).toHaveBeenCalledTimes(5);
    filters.forEach((filter, index) => {
      expect(request).toHaveBeenNthCalledWith(
        index + 1,
        expect.stringContaining("query IssueSuggestions"),
        {
          filter: { ...filter, state: { type: { nin: ["completed", "canceled"] } } },
          first: 50,
          after: null,
        }
      );
    });
  });

  it("loads later pages before sorting and uses recency to break priority ties", async () => {
    const { service, request } = setup();
    request.mockImplementation(
      async (
        _query: string,
        { filter, after }: { filter: Record<string, unknown>; after: string | null }
      ) => ({
        data: {
          issues: filter.assignee
            ? after
              ? page([node("urgent", 1), node("recent", 2, "2026-10-20T00:00:00Z")])
              : page([node("old", 2)], "next")
            : page([]),
        },
      })
    );
    expect((await service.fetchSuggestedIssues()).map((issue) => issue.id)).toEqual([
      "urgent",
      "recent",
      "old",
    ]);
    expect(request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ after: "next" })
    );
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("falls back to issues in all viewer teams only when every personal group is empty", async () => {
    const { service, request } = setup();
    for (let index = 0; index < filters.length; index++)
      request.mockResolvedValueOnce({ data: { issues: page([]) } });
    request
      .mockResolvedValueOnce({
        data: { viewer: { teams: { ...page([], "next-team"), nodes: [{ id: "team-a" }] } } },
      })
      .mockResolvedValueOnce({
        data: { viewer: { teams: { ...page([]), nodes: [{ id: "team-b" }] } } },
      })
      .mockResolvedValueOnce({ data: { issues: page([node("low", 4), node("urgent", 1)]) } });
    expect((await service.fetchSuggestedIssues()).map((issue) => issue.id)).toEqual([
      "urgent",
      "low",
    ]);
    expect(request).toHaveBeenNthCalledWith(7, expect.stringContaining("query ViewerTeams"), {
      after: "next-team",
    });
    expect(request).toHaveBeenLastCalledWith(expect.any(String), {
      filter: {
        team: { id: { in: ["team-a", "team-b"] } },
        state: { type: { nin: ["completed", "canceled"] } },
      },
      first: 50,
      after: null,
    });
  });

  it("returns no suggestions when the viewer has no teams", async () => {
    const { service, request } = setup();
    for (let index = 0; index < filters.length; index++)
      request.mockResolvedValueOnce({ data: { issues: page([]) } });
    request.mockResolvedValueOnce({ data: { viewer: { teams: page([]) } } });
    await expect(service.fetchSuggestedIssues()).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(6);
  });

  it("propagates load failures rather than treating them as empty results", async () => {
    const { service, request } = setup();
    request.mockRejectedValue(new Error("offline"));
    await expect(service.fetchSuggestedIssues()).rejects.toThrow("offline");
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("preserves remote search with assigned issues first", async () => {
    const { service, request } = setup();
    request.mockResolvedValueOnce({ data: { viewer: { id: "viewer" } } }).mockResolvedValueOnce({
      data: {
        searchIssues: {
          nodes: [
            { ...node("other"), assignee: null },
            { ...node("mine"), assignee: { id: "viewer" } },
          ],
        },
      },
    });
    expect((await service.fetchSuggestedIssues("  issue  ")).map((issue) => issue.id)).toEqual([
      "mine",
      "other",
    ]);
    expect(request).toHaveBeenLastCalledWith(expect.stringContaining("query SearchIssues"), {
      query: "issue",
      first: 50,
    });
  });
});

describe("marked issues", () => {
  const marker = "lint:api:unit-1";
  const input = {
    marker,
    team: "eng",
    title: "Lint: unit 1",
    project: "Code quality",
    assignee: "me",
    labels: ["Lint"],
  };
  const marked = (title: string, state = "Todo", labels = [{ id: "label" }]) => ({
    issues: {
      nodes: [
        {
          id: "issue",
          identifier: "ENG-9",
          url: "https://linear.app/x/ENG-9",
          branchName: "me/eng-9-lint-unit-1",
          title,
          state: { id: "s-todo", name: state },
          labels: { nodes: labels },
          projectMilestone: null,
          team: {
            id: "team",
            key: "ENG",
            states: {
              nodes: [
                { id: "s-todo", name: "Todo" },
                { id: "s-review", name: "In Review" },
              ],
            },
          },
        },
      ],
    },
  });
  const context = {
    viewer: { id: "viewer" },
    teams: { nodes: [{ id: "team", key: "ENG", name: "Engineering" }] },
    issueLabels: {
      nodes: [
        { id: "other-team-label", name: "Lint", team: { id: "other" } },
        { id: "label", name: "Lint", team: null },
      ],
    },
  };
  const service = (...responses: unknown[]) => {
    const linear = new LinearService("test-key");
    const request = vi.fn();
    for (const data of responses) request.mockResolvedValueOnce({ data });
    Object.defineProperty(linear, "gql", { value: { rawRequest: request } });
    return { linear, request };
  };

  it("reuses the issue the marker finds and retitles it when the title changed", async () => {
    const same = service(marked("Lint: unit 1"), context);
    await expect(same.linear.upsertMarkedIssue(input)).resolves.toEqual({
      id: "issue",
      identifier: "ENG-9",
      title: "Lint: unit 1",
      url: "https://linear.app/x/ENG-9",
      branchName: "me/eng-9-lint-unit-1",
      created: false,
      updated: false,
      warnings: [],
    });
    expect(same.request.mock.calls[0][1]).toEqual({ marker });
    expect(same.request).toHaveBeenCalledTimes(2);

    const renamed = service(marked("Old"), context, { issueUpdate: { success: true } });
    await expect(renamed.linear.upsertMarkedIssue(input)).resolves.toMatchObject({
      updated: true,
      title: "Lint: unit 1",
    });
    expect(renamed.request.mock.calls[2][1]).toEqual({
      id: "issue",
      input: { title: "Lint: unit 1" },
    });

    const rejected = service(marked("Old"), context, { issueUpdate: { success: false } });
    await expect(rejected.linear.upsertMarkedIssue(input)).rejects.toThrow(
      "Linear rejected the issue update"
    );
  });

  it("creates the issue with the marker as its description", async () => {
    const created = {
      id: "new",
      identifier: "ENG-10",
      url: "https://linear.app/x/ENG-10",
      branchName: "me/eng-10-lint-unit-1",
    };
    const { linear, request } = service(
      { issues: { nodes: [] } },
      context,
      { projects: { nodes: [{ id: "project" }] } },
      { issueCreate: { success: true, issue: created } }
    );
    await expect(linear.upsertMarkedIssue(input)).resolves.toEqual({
      ...created,
      title: "Lint: unit 1",
      created: true,
      updated: false,
      warnings: [],
    });
    expect(request.mock.calls[1][1]).toEqual({ labels: ["Lint"] });
    expect(request.mock.calls[2][1]).toEqual({ project: "Code quality" });
    expect(request.mock.calls[3][1]).toEqual({
      input: {
        teamId: "team",
        title: "Lint: unit 1",
        description: marker,
        assigneeId: "viewer",
        labelIds: ["label"],
        projectId: "project",
      },
    });
  });

  it("assigns another user without a project", async () => {
    const { linear, request } = service(
      { issues: { nodes: [] } },
      context,
      { users: { nodes: [{ id: "user" }] } },
      { issueCreate: { success: true, issue: { id: "n", identifier: "ENG-1", url: "u" } } }
    );
    await linear.upsertMarkedIssue({
      ...input,
      team: "team",
      project: null,
      assignee: "ana@example.com",
      labels: [],
    });
    expect(request.mock.calls[2][1]).toEqual({ user: "ana@example.com" });
    expect(request.mock.calls[3][1]).toEqual({
      input: {
        teamId: "team",
        title: "Lint: unit 1",
        description: marker,
        assigneeId: "user",
        labelIds: [],
      },
    });
  });

  it.each([
    [{ team: "web" }, [context], "Linear team web not found"],
    [{}, [context, { projects: { nodes: [] } }], "Linear project Code quality not found"],
    [
      { project: null },
      [context, { issueCreate: { success: false, issue: null } }],
      "Linear rejected the issue creation",
    ],
  ])("reports what it cannot resolve or create: %j", async (overrides, responses, message) => {
    const { linear } = service({ issues: { nodes: [] } }, ...responses);
    await expect(linear.upsertMarkedIssue({ ...input, ...overrides })).rejects.toThrow(message);
  });

  const milestones = {
    projects: {
      nodes: [{ id: "project", projectMilestones: { nodes: [{ id: "m1", name: "M1" }] } }],
    },
  };

  it("creates the issue with the labels and milestone that resolve and warns about the rest", async () => {
    const { linear, request } = service({ issues: { nodes: [] } }, context, milestones, {
      issueCreate: { success: true, issue: { id: "n", identifier: "ENG-1", url: "u" } },
    });
    const result = await linear.upsertMarkedIssue({
      ...input,
      labels: ["Lint", " ", "lint:missing"],
      milestone: "m1",
    });
    expect(result.warnings).toEqual([
      "A Linear label rendered empty; skipped it",
      "Linear label lint:missing not found in team ENG; skipped it",
    ]);
    expect(request.mock.calls[1][1]).toEqual({ labels: ["Lint", "lint:missing"] });
    expect(request.mock.calls[3][1]).toMatchObject({
      input: { labelIds: ["label"], projectId: "project", projectMilestoneId: "m1" },
    });
  });

  it.each([
    [{ milestone: "M9" }, "Linear milestone M9 not found in the project; skipped it"],
    [{ milestone: " " }, "The Linear milestone rendered empty; skipped it"],
    [{ milestone: "M1", project: null }, "Linear milestone M1 needs a project; skipped it"],
  ])(
    "creates the issue without a milestone that does not resolve: %j",
    async (overrides, warning) => {
      const lookups = "project" in overrides ? [] : [milestones];
      const { linear, request } = service({ issues: { nodes: [] } }, context, ...lookups, {
        issueCreate: { success: true, issue: { id: "n", identifier: "ENG-1", url: "u" } },
      });
      const result = await linear.upsertMarkedIssue({ ...input, ...overrides });
      expect(result.warnings).toEqual([warning]);
      expect(request.mock.calls.at(-1)![1]).not.toHaveProperty("input.projectMilestoneId");
    }
  );

  it("adds the labels and milestone a reused issue lacks", async () => {
    const { linear, request } = service(marked("Lint: unit 1", "Todo", []), context, milestones, {
      issueUpdate: { success: true },
    });
    const result = await linear.upsertMarkedIssue({
      ...input,
      labels: ["Lint", "Missing"],
      milestone: "M1",
    });
    expect(result).toMatchObject({
      updated: true,
      warnings: ["Linear label Missing not found in team ENG; skipped it"],
    });
    expect(request.mock.calls[2][1]).toEqual({ project: "Code quality" });
    expect(request.mock.calls[3][1]).toEqual({
      id: "issue",
      input: { addedLabelIds: ["label"], projectMilestoneId: "m1" },
    });
  });

  it("moves the marked issue to a state of its team by name", async () => {
    const moved = service(marked("t"), { issueUpdate: { success: true } });
    await expect(moved.linear.moveMarkedIssue(marker, "in review")).resolves.toEqual({
      identifier: "ENG-9",
      changed: true,
    });
    expect(moved.request.mock.calls[1][1]).toEqual({ id: "issue", input: { stateId: "s-review" } });

    const already = service(marked("t", "In Review"));
    await expect(already.linear.moveMarkedIssue(marker, "In Review")).resolves.toEqual({
      identifier: "ENG-9",
      changed: false,
    });

    const unknown = service(marked("t"));
    await expect(unknown.linear.moveMarkedIssue(marker, "Shipped")).rejects.toThrow(
      "Linear state Shipped not found in the issue's team"
    );

    const missing = service({ issues: { nodes: [] } });
    await expect(missing.linear.moveMarkedIssue(marker, "Done")).rejects.toThrow(
      `No Linear issue carries the marker ${marker}`
    );
  });
});

describe("Linear requests", () => {
  const unanswered = vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
      })
  );

  afterEach(() => vi.unstubAllGlobals());

  it("fail with a timeout when Linear never answers, raw or through the SDK", async () => {
    vi.stubGlobal("fetch", unanswered);
    const linear = new LinearService("test-key", 20);

    await expect(linear.moveMarkedIssue("lint:api:unit-1", "Done")).rejects.toThrow(
      "Linear did not answer within 0.02s"
    );
    await expect(linear.updateIssueTitle("issue", "Title")).rejects.toThrow(
      "Linear did not answer within 0.02s"
    );
    const [first, second] = unanswered.mock.calls.map(([, init]) => init.signal);
    expect(first).not.toBe(second);
  });
});

describe("issues and projects created by name", () => {
  const service = (...responses: unknown[]) => {
    const linear = new LinearService("test-key");
    const request = vi.fn();
    for (const data of responses) request.mockResolvedValueOnce({ data });
    Object.defineProperty(linear, "gql", { value: { rawRequest: request } });
    return { linear, request };
  };
  const context = {
    viewer: { id: "viewer" },
    teams: { nodes: [{ id: "team", key: "ENG", name: "Engineering" }] },
    issueLabels: {
      nodes: [
        { id: "other-team-label", name: "Bug", team: { id: "other" } },
        { id: "label", name: "Bug", team: { id: "team" } },
      ],
    },
  };
  const projectNode = {
    id: "project",
    name: "Checkout",
    slugId: "abc123",
    url: "https://linear.app/x/project/checkout-abc123",
    progress: 0.5,
    updatedAt: "2026-11-01T00:00:00.000Z",
    startDate: null,
    targetDate: "2026-12-31",
    status: { name: "Planned", type: "planned" },
    lead: null,
    teams: { nodes: [{ key: "ENG" }] },
    description: "Summary",
    content: null,
    projectMilestones: { nodes: [{ id: "m1", name: "Beta", targetDate: null }] },
  };
  const issue = {
    id: "new",
    identifier: "ENG-7",
    title: "Fix login",
    url: "u",
    branchName: "me/eng-7-fix-login",
    project: null,
    state: { name: "Todo", type: "unstarted" },
  };
  const mutations = (request: ReturnType<typeof vi.fn>, name: string) =>
    request.mock.calls.filter(([query]) => String(query).includes(name)).length;

  it("creates an issue assigned to the viewer by default", async () => {
    const { linear, request } = service(context, { issueCreate: { success: true, issue } });
    await expect(linear.createNamedIssue({ team: "eng", title: "Fix login" })).resolves.toEqual(
      issue
    );
    expect(request.mock.calls[0][1]).toEqual({ labels: [] });
    expect(request.mock.calls[1][1]).toEqual({
      input: { teamId: "team", title: "Fix login", assigneeId: "viewer" },
    });
  });

  it("resolves every named field of the issue", async () => {
    const { linear, request } = service(
      context,
      { projects: { nodes: [projectNode] } },
      { users: { nodes: [{ id: "ana" }] } },
      { team: { states: { nodes: [{ id: "s-todo", name: "Todo" }] } } },
      { issueCreate: { success: true, issue: { ...issue, project: { id: "project" } } } }
    );
    await linear.createNamedIssue({
      team: "Engineering",
      title: "Fix login",
      description: "Steps",
      project: "https://linear.app/x/project/checkout-abc123/overview",
      milestone: "beta",
      assignee: "ana@example.com",
      labels: ["Bug"],
      priority: 2,
      state: "todo",
    });
    expect(request.mock.calls[1][1]).toEqual({ filter: { slugId: { eq: "abc123" } } });
    expect(request.mock.calls[2][1]).toEqual({ user: "ana@example.com" });
    expect(request.mock.calls[3][1]).toEqual({ team: "team" });
    expect(request.mock.calls[4][1]).toEqual({
      input: {
        teamId: "team",
        title: "Fix login",
        description: "Steps",
        assigneeId: "ana",
        labelIds: ["label"],
        projectId: "project",
        projectMilestoneId: "m1",
        priority: 2,
        stateId: "s-todo",
      },
    });
  });

  it("leaves an issue unassigned when the assignee is null", async () => {
    const { linear, request } = service(context, { issueCreate: { success: true, issue } });
    await linear.createNamedIssue({ team: "ENG", title: "T", assignee: null, priority: 0 });
    expect(request.mock.calls[1][1]).toEqual({
      input: { teamId: "team", title: "T", priority: 0 },
    });
  });

  it.each([
    [{ team: "WEB" }, [], "Linear team WEB not found"],
    [{ labels: ["Chore"] }, [], "Linear label Chore not found in team ENG"],
    [{ project: "Nope" }, [{ projects: { nodes: [] } }], "Linear project Nope not found"],
    [
      { project: "Checkout", milestone: "GA" },
      [{ projects: { nodes: [projectNode] } }],
      "Linear milestone GA not found in project Checkout",
    ],
    [{ assignee: "nobody" }, [{ users: { nodes: [] } }], "Linear user nobody not found"],
    [
      { state: "Shipped" },
      [{ team: { states: { nodes: [] } } }],
      "Linear state Shipped not found in team ENG",
    ],
  ])("creates nothing when a name does not resolve: %j", async (fields, responses, error) => {
    const { linear, request } = service(context, ...responses);
    await expect(linear.createNamedIssue({ team: "ENG", title: "T", ...fields })).rejects.toThrow(
      error
    );
    expect(mutations(request, "issueCreate")).toBe(0);
  });

  it("reports an issue creation Linear rejects", async () => {
    const { linear } = service(context, { issueCreate: { success: false, issue: null } });
    await expect(linear.createNamedIssue({ team: "ENG", title: "T" })).rejects.toThrow(
      "Linear rejected the issue creation"
    );
  });

  it("refuses a milestone without a project before asking Linear", async () => {
    const { linear, request } = service();
    await expect(
      linear.createNamedIssue({ team: "ENG", title: "T", milestone: "Beta" })
    ).rejects.toThrow("A Linear milestone needs a project");
    expect(request).not.toHaveBeenCalled();
  });

  it("creates a project with its teams, lead and status resolved", async () => {
    const { linear, request } = service(
      context,
      { projectStatuses: { nodes: [{ id: "st", name: "Planned" }] } },
      { projectCreate: { success: true, project: projectNode } }
    );
    const project = await linear.createProject({
      name: "Checkout",
      teams: ["ENG", "engineering"],
      description: "Summary",
      content: "# Goals",
      lead: "me",
      status: "planned",
      startDate: "2026-12-01",
      targetDate: "2026-12-31",
    });
    expect(project).toMatchObject({
      id: "project",
      teams: ["ENG"],
      milestones: [{ id: "m1", name: "Beta", targetDate: null }],
    });
    expect(request.mock.calls[2][1]).toEqual({
      input: {
        name: "Checkout",
        teamIds: ["team"],
        description: "Summary",
        content: "# Goals",
        leadId: "viewer",
        statusId: "st",
        startDate: "2026-12-01",
        targetDate: "2026-12-31",
      },
    });
  });

  it("creates a project with only its name and teams", async () => {
    const { linear, request } = service(context, {
      projectCreate: { success: true, project: projectNode },
    });
    await linear.createProject({ name: "Checkout", teams: ["ENG"] });
    expect(request.mock.calls[1][1]).toEqual({ input: { name: "Checkout", teamIds: ["team"] } });
  });

  it.each([
    [{ teams: ["WEB"] }, [context], "Linear team WEB not found"],
    [
      { status: "Shipped" },
      [context, { projectStatuses: { nodes: [] } }],
      "Linear project status Shipped not found",
    ],
    [
      {},
      [context, { projectCreate: { success: false, project: null } }],
      "Linear rejected the project creation",
    ],
  ])("fails to create a project that does not resolve: %j", async (fields, responses, error) => {
    const { linear } = service(...responses);
    await expect(linear.createProject({ name: "P", teams: ["ENG"], ...fields })).rejects.toThrow(
      error
    );
  });

  it("lists every page of projects, filtered by team", async () => {
    const page = (nodes: unknown[], endCursor: string | null) => ({
      projects: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
    });
    const { linear, request } = service(
      context,
      page([projectNode], "c1"),
      page([{ ...projectNode, id: "p2", status: null, lead: { name: "Ana" } }], null)
    );
    const projects = await linear.listProjects("ENG");
    expect(projects.map((project) => [project.id, project.status, project.lead])).toEqual([
      ["project", { name: "Planned", type: "planned" }, null],
      ["p2", null, { name: "Ana" }],
    ]);
    expect(projects[0]).not.toHaveProperty("content");
    const filter = { accessibleTeams: { some: { id: { eq: "team" } } } };
    expect(request.mock.calls[1][1]).toEqual({ filter, after: null });
    expect(request.mock.calls[2][1]).toEqual({ filter, after: "c1" });
  });

  it("lists projects of every team without a team", async () => {
    const { linear, request } = service({
      projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    await expect(linear.listProjects()).resolves.toEqual([]);
    expect(request.mock.calls[0][1]).toEqual({ filter: undefined, after: null });
  });

  it("gets a project by reference or says it is missing", async () => {
    const found = service({ projects: { nodes: [projectNode] } });
    await expect(found.linear.getProject("checkout")).resolves.toMatchObject({
      name: "Checkout",
      description: "Summary",
      content: null,
    });
    const missing = service({ projects: { nodes: [] } });
    await expect(missing.linear.getProject("nope")).rejects.toThrow(
      "Linear project nope not found"
    );
  });
});

describe("projectFilter", () => {
  it.each([
    [
      "8a7f3c2e-1b4d-4e6f-9a0b-1c2d3e4f5a6b",
      { id: { eq: "8a7f3c2e-1b4d-4e6f-9a0b-1c2d3e4f5a6b" } },
    ],
    ["https://linear.app/x/project/checkout-v2-abc123/issues", { slugId: { eq: "abc123" } }],
    [
      " Checkout ",
      { or: [{ name: { eqIgnoreCase: "Checkout" } }, { slugId: { eq: "Checkout" } }] },
    ],
  ])("finds %s", (ref, filter) => {
    expect(projectFilter(ref)).toEqual(filter);
  });
});
