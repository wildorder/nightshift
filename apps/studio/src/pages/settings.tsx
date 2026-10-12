/**
 * Settings › organisation (T3, D-P11-10; by role since D-RR-01): which models
 * run each role, in order of preference, and how work is examined, edited and
 * saved with the version it was read at. A save over a newer version is refused
 * by the store (`StaleWriteError`) and shown as such, never retried silently.
 */
import type {
  ExaminationPolicy,
  OrgConfig,
  RolePreferences,
  RouteSpec,
  RoutingPolicy,
  RoutingRole,
} from "@nightshift/contracts";
import {
  catalogEntry,
  defaultOrgConfig,
  EffortSchema,
  ExaminationPolicySchema,
  MODEL_CATALOG,
  ROUTING_ROLES,
  RoutingPolicySchema,
} from "@nightshift/contracts";
import { StaleWriteError } from "@nightshift/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Json } from "../components/json.js";
import { useStudio } from "../studio.js";

const RISKS = ["low", "medium", "high"] as const;
const REQUIREMENTS = [
  ["required", "Examined"],
  ["mustDifferModel", "By a different model"],
  ["mustDifferProvider", "By a different provider"],
  ["blockOnMaterialFindings", "A serious finding blocks landing"],
] as const;

/** What each role is, said the way a person would. */
const ROLES: Readonly<Record<RoutingRole, { readonly title: string; readonly about: string }>> = {
  orchestrator: {
    title: "Orchestrator",
    about: "Plans the run and hands out the work.",
  },
  implementer: {
    title: "Implementer",
    about:
      "Writes the code for each job. When a job's work fails and is retried, the retry moves to the next model down this list.",
  },
  examiner: {
    title: "Examiner",
    about:
      "Reviews finished work before it lands. Takes the first model that is independent enough of the one that wrote the code.",
  },
  arbiter: {
    title: "Arbiter",
    about:
      "Settles a dispute between the implementer and the examiner. Prefers a model neither of them used.",
  },
};

/** The `<select>` value for a model outside the catalog. */
const OTHER = "__other__";

interface Draft {
  readonly roles: RolePreferences;
  readonly unavailableJson: string;
  readonly pricesJson: string;
  readonly examinationPolicy: ExaminationPolicy;
}

const draftOf = (config: OrgConfig): Draft => ({
  roles: config.routingPolicy.roles,
  unavailableJson: JSON.stringify(config.routingPolicy.unavailable, null, 2),
  pricesJson: JSON.stringify(config.routingPolicy.prices, null, 2),
  examinationPolicy: config.examinationPolicy,
});

const parseJson = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new Error(
      `${what} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
};

/** The body a save sends, or the reasons it cannot. */
export const policiesOf = (
  draft: Draft,
): { readonly routingPolicy: RoutingPolicy; readonly examinationPolicy: ExaminationPolicy } => {
  for (const role of ROUTING_ROLES) {
    if (draft.roles[role].length === 0) {
      throw new Error(`${ROLES[role].title} needs at least one model.`);
    }
    if (draft.roles[role].some((route) => route.model.trim() === "")) {
      throw new Error(`${ROLES[role].title} has a row with no model chosen.`);
    }
  }
  const routing = RoutingPolicySchema.safeParse({
    roles: draft.roles,
    unavailable: parseJson(draft.unavailableJson, "Routes nobody may use"),
    prices: parseJson(draft.pricesJson, "Prices"),
  });
  if (!routing.success) {
    throw new Error(
      `routing policy: ${routing.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const examination = ExaminationPolicySchema.safeParse(draft.examinationPolicy);
  if (!examination.success) throw new Error(`examination policy: ${examination.error.message}`);
  return { routingPolicy: routing.data, examinationPolicy: examination.data };
};

const field = "h-8 rounded-md border border-input bg-background px-2 text-sm";

/** One place on a role's list: which model, how hard it thinks, and where it sits. */
const ChoiceRow = ({
  role,
  index,
  count,
  route,
  onChange,
  onMove,
  onRemove,
}: {
  readonly role: RoutingRole;
  readonly index: number;
  readonly count: number;
  readonly route: RouteSpec;
  readonly onChange: (next: RouteSpec) => void;
  readonly onMove: (by: -1 | 1) => void;
  readonly onRemove: () => void;
}) => {
  const known = catalogEntry(route.model);
  const [other, setOther] = useState(known === undefined && route.model !== "");
  const name = `${ROLES[role].title} choice ${index + 1}`;
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-6 text-right tabular-nums text-muted-foreground">{index + 1}.</span>
      <select
        aria-label={name}
        className={`${field} w-56`}
        value={other ? OTHER : (known?.model ?? "")}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setOther(true);
            return;
          }
          setOther(false);
          const entry = catalogEntry(e.target.value);
          if (entry !== undefined)
            onChange({ ...route, harness: entry.harness, model: entry.model });
        }}
      >
        <option value="" disabled>
          Choose a model…
        </option>
        {(["Anthropic", "OpenAI"] as const).map((provider) => (
          <optgroup key={provider} label={provider}>
            {MODEL_CATALOG.filter((entry) => entry.provider === provider).map((entry) => (
              <option key={entry.model} value={entry.model}>
                {entry.label}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={OTHER}>Another model…</option>
      </select>
      {other ? (
        <>
          <select
            aria-label={`${name} harness`}
            className={field}
            value={route.harness}
            onChange={(e) => onChange({ ...route, harness: e.target.value })}
          >
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
          <input
            aria-label={`${name} model id`}
            placeholder="model id"
            className={`${field} w-48`}
            value={route.model}
            onChange={(e) => onChange({ ...route, model: e.target.value })}
          />
        </>
      ) : null}
      <select
        aria-label={`${name} effort`}
        className={field}
        value={route.effort ?? ""}
        onChange={(e) => {
          const { effort: _effort, ...rest } = route;
          onChange(
            e.target.value === "" ? rest : { ...rest, effort: EffortSchema.parse(e.target.value) },
          );
        }}
      >
        <option value="">Default thinking</option>
        {EffortSchema.options.map((effort) => (
          <option key={effort} value={effort}>
            {effort} thinking
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Move ${name} up`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        ↑
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Move ${name} down`}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        ↓
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Remove ${name}`}
        disabled={count === 1}
        onClick={onRemove}
      >
        Remove
      </Button>
    </li>
  );
};

/** A role's list, in order of preference. */
const RoleList = ({
  role,
  routes,
  onChange,
}: {
  readonly role: RoutingRole;
  readonly routes: readonly RouteSpec[];
  readonly onChange: (next: RouteSpec[]) => void;
}) => (
  <fieldset className="rounded-lg border p-3">
    <legend className="px-1 font-medium">{ROLES[role].title}</legend>
    <p className="mb-2 text-xs text-muted-foreground">{ROLES[role].about}</p>
    <ol className="flex flex-col gap-1">
      {routes.map((route, index) => (
        <ChoiceRow
          // biome-ignore lint/suspicious/noArrayIndexKey: a choice is its place on the list
          key={`${role}-${index}-${route.model}`}
          role={role}
          index={index}
          count={routes.length}
          route={route}
          onChange={(next) => onChange(routes.map((r, i) => (i === index ? next : r)))}
          onMove={(by) => {
            const next = [...routes];
            const [moved] = next.splice(index, 1);
            if (moved !== undefined) next.splice(index + by, 0, moved);
            onChange(next);
          }}
          onRemove={() => onChange(routes.filter((_, i) => i !== index))}
        />
      ))}
    </ol>
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="mt-2"
      aria-label={`Add a model to ${ROLES[role].title}`}
      onClick={() => onChange([...routes, { harness: "claude", model: "" }])}
    >
      Add a model
    </Button>
  </fieldset>
);

export const OrgSettingsPage = () => {
  const { stores, orgId, identity } = useStudio();
  const client = useQueryClient();
  const config = useQuery({
    queryKey: ["orgConfig", orgId],
    queryFn: async (): Promise<OrgConfig | undefined> => {
      if (orgId === undefined) return undefined;
      return (
        (await stores.orgConfigs.get(orgId)) ?? defaultOrgConfig(orgId, new Date().toISOString())
      );
    },
  });
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (config.data !== undefined) {
      setDraft(draftOf(config.data));
      setStale(false);
    }
  }, [config.data]);

  const save = useMutation({
    mutationFn: async () => {
      const base = config.data;
      if (base === undefined || draft === undefined) throw new Error("nothing to save");
      const policies = policiesOf(draft);
      await stores.orgConfigs.put({
        schemaVersion: 1,
        orgId: base.orgId,
        ...policies,
        // A policy write leaves the org's GitHub installations as they are (D-P10-28).
        installations: base.installations,
        version: base.version + 1,
        updatedAt: new Date().toISOString(),
      });
    },
    onSuccess: async () => {
      setProblem(undefined);
      await client.invalidateQueries({ queryKey: ["orgConfig", orgId] });
    },
    onError: (error) => {
      if (error instanceof StaleWriteError) {
        setStale(true);
        setProblem(undefined);
      } else {
        setProblem(error instanceof Error ? error.message : String(error));
      }
    },
  });

  if (orgId === undefined) {
    return (
      <p className="text-muted-foreground">
        This session acts for no organisation with a project yet, so there is no configuration to
        show.
      </p>
    );
  }
  if (config.isPending || draft === undefined) return <p>Loading configuration…</p>;
  if (config.isError || config.data === undefined) {
    return <p role="alert">Could not read the organisation's configuration.</p>;
  }
  const base = config.data;

  return (
    <section className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Organisation settings</h1>
        <p className="text-sm text-muted-foreground">
          <code>{orgId}</code> · configuration version {base.version}
          {base.version === 0 ? " (the seeded default; nobody has written one yet)" : ""} · signed
          in as {identity.email ?? identity.subject ?? "?"}
        </p>
      </header>

      {stale ? (
        <div
          role="alert"
          className="rounded-md border border-status-warning-foreground/30 bg-status-warning p-3 text-sm text-status-warning-foreground"
        >
          The configuration changed since you read it (you read version {base.version}). Nothing was
          saved.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void client.invalidateQueries({ queryKey: ["orgConfig", orgId] })}
          >
            Reload
          </button>{" "}
          and make your change again.
        </div>
      ) : null}
      {problem === undefined ? null : (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {problem}
        </p>
      )}

      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="font-semibold">Who runs what</h2>
            <p className="text-sm text-muted-foreground">
              Each role tries its models in order. If one has hit a usage limit or can't start, the
              next one takes over, and the limited one comes back once its limit resets.
            </p>
          </div>
          {ROUTING_ROLES.map((role) => (
            <RoleList
              key={role}
              role={role}
              routes={draft.roles[role]}
              onChange={(routes) =>
                setDraft({ ...draft, roles: { ...draft.roles, [role]: routes } })
              }
            />
          ))}
        </div>

        <div>
          <h2 className="font-semibold">Review</h2>
          <p className="mb-2 text-sm text-muted-foreground">
            How work is examined before it lands, by the risk the job was given.
          </p>
          <table className="text-sm">
            <thead>
              <tr>
                <th className="p-1 text-left">Risk</th>
                {REQUIREMENTS.map(([key, label]) => (
                  <th key={key} className="p-1 text-left font-normal">
                    {label}
                  </th>
                ))}
                <th className="p-1 text-left font-normal">
                  If no independent examiner is free, review now with the first available (instead
                  of waiting)
                </th>
              </tr>
            </thead>
            <tbody>
              {RISKS.map((risk) => (
                <tr key={risk}>
                  <td className="p-1 font-mono">{risk}</td>
                  {REQUIREMENTS.map(([key]) => (
                    <td key={key} className="p-1">
                      <input
                        type="checkbox"
                        aria-label={`${risk} ${key}`}
                        checked={draft.examinationPolicy[risk][key]}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            examinationPolicy: {
                              ...draft.examinationPolicy,
                              [risk]: { ...draft.examinationPolicy[risk], [key]: e.target.checked },
                            },
                          })
                        }
                      />
                    </td>
                  ))}
                  <td className="p-1">
                    <input
                      type="checkbox"
                      aria-label={`${risk} whenIndependentUnavailable`}
                      checked={
                        draft.examinationPolicy[risk].whenIndependentUnavailable === "strongest"
                      }
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          examinationPolicy: {
                            ...draft.examinationPolicy,
                            [risk]: {
                              ...draft.examinationPolicy[risk],
                              whenIndependentUnavailable: e.target.checked ? "strongest" : "wait",
                            },
                          },
                        })
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <details>
          <summary className="cursor-pointer text-sm font-semibold">Advanced</summary>
          {(
            [
              [
                "unavailableJson",
                "Routes nobody may use",
                "Models to skip for every role, e.g. one being retired.",
              ],
              [
                "pricesJson",
                "Prices",
                "Per model, dollars per million tokens, for cost estimates.",
              ],
            ] as const
          ).map(([key, label, hint]) => (
            <div key={key} className="mt-3">
              <h3 className="mb-1 text-sm font-medium">{label}</h3>
              <p className="mb-1 text-xs text-muted-foreground">{hint}</p>
              <textarea
                aria-label={label}
                className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
                rows={6}
                value={draft[key]}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              />
            </div>
          ))}
        </details>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            Save as version {base.version + 1}
          </Button>
          <Button type="button" variant="outline" onClick={() => setDraft(draftOf(base))}>
            Discard changes
          </Button>
          {save.isSuccess && !stale ? (
            <span className="text-sm text-status-success-foreground">Saved.</span>
          ) : null}
        </div>
      </form>

      <details>
        <summary className="cursor-pointer text-sm">The configuration as stored (JSON)</summary>
        <Json label="org config" value={base} />
      </details>
    </section>
  );
};
