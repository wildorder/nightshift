import io
def edit(p, pairs):
    s=io.open(p,encoding='utf-8',newline='').read()
    for old,new in pairs:
        assert old in s, (p, old[:70]); s=s.replace(old,new,1)
    io.open(p,'w',encoding='utf-8',newline='').write(s)

edit('apps/api/src/handler-remote.test.ts', [
('''const setup = async (overrides: Partial<ApiDeps> = {}): Promise<World> => {''',
'''/** A world; `without` names the optional dependencies this plane is wired without. */
const setup = async (without: readonly ("envelope" | "github")[] = []): Promise<World> => {'''),
('''      tokens: {
        issuer: ISSUER,
        signer: { sign: async (input) => signWith("sha256", input, keys.privateKey) },
      },
      ...overrides,
    },
  };
};''',
'''      tokens: {
        issuer: ISSUER,
        signer: { sign: async (input) => signWith("sha256", input, keys.privateKey) },
      },
    },
  };
};

const omitting = (w: World, ...names: readonly ("envelope" | "github")[]): World => {
  const deps: Record<string, unknown> = { ...w.deps };
  for (const name of names) delete deps[name];
  return { ...w, deps: deps as unknown as ApiDeps };
};'''),
('''    const w = await setup({ envelope: undefined });''',
'''    const w = omitting(await setup(), "envelope");'''),
('''    const without = await setup({ github: undefined });''',
'''    const without = omitting(await setup(), "github");'''),
])

edit('packages/core/src/rules/authorize-engine.test.ts', [
('''    expect(authorize(engine(), "node.put", target({ requestedNodeStatus: undefined }))).toMatchObject(
      { allowed: false },
    );''',
'''    const { requestedNodeStatus: _status, ...noStatus } = target();
    expect(authorize(engine(), "node.put", noStatus)).toMatchObject({ allowed: false });'''),
('''    expect(authorize(engine(), operation, target({ currentGeneration: undefined }))).toMatchObject({
      allowed: false,
      reason: "stale_generation",
    });''',
'''    const { currentGeneration: _generation, ...unresolved } = target();
    expect(authorize(engine(), operation, unresolved)).toMatchObject({
      allowed: false,
      reason: "stale_generation",
    });'''),
('''    const worker: Principal = { ...engine(1), role: "worker", nodeId: OTHER_NODE };''',
'''    const worker: Principal = {
      kind: "execution",
      ...here.scope,
      nodeId: OTHER_NODE,
      agentId: OWN_AGENT,
      role: "worker",
      generation: 1,
    };'''),
])

edit('packages/core/src/rules/dispatch.test.ts', [
('''    expect(leaseLost(at("stopping", { leaseExpiresAt: expired }), nowMs)).toBe(true === false);''',
'''    expect(leaseLost(at("stopping", { leaseExpiresAt: expired }), nowMs)).toBe(false);'''),
])

edit('packages/persistence/src/aws/stores.test.ts', [
('''      expect(first.cursor).toBeDefined();
      const rest = await stores.computeUtilizations.listByProject(f.scope.projectId, {
        limit: 2,
        cursor: first.cursor,
      });''',
'''      expect(first.cursor).toBeDefined();
      const rest = await stores.computeUtilizations.listByProject(f.scope.projectId, {
        limit: 2,
        cursor: first.cursor ?? "",
      });'''),
])
print('ok')
