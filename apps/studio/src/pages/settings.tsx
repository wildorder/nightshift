/**
 * Settings › organisation (T3, D-P11-10): the org's routing and examination
 * policy, edited and saved with the version it was read at. A save over a newer
 * version is refused by the store (`StaleWriteError`) and shown as such, never
 * retried silently.
 */
import type { ExaminationPolicy, OrgConfig, RouteSpec, RoutingPolicy } from "@nightshift/contracts";
import {
  defaultOrgConfig,
  EffortSchema,
  ExaminationPolicySchema,
  RoutingPolicySchema,
  TierSchema,
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
  ["blockOnMaterialFindings", "A material finding blocks landing"],
] as const;

interface Draft {
  readonly ladders: RoutingPolicy["ladders"];
  readonly rulesJson: string;
  readonly unavailableJson: string;
  readonly pricesJson: string;
  readonly examinationPolicy: ExaminationPolicy;
}

const draftOf = (config: OrgConfig): Draft => ({
  ladders: config.routingPolicy.ladders,
  rulesJson: JSON.stringify(config.routingPolicy.rules, null, 2),
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
  const routing = RoutingPolicySchema.safeParse({
    ladders: draft.ladders,
    rules: parseJson(draft.rulesJson, "rules"),
    unavailable: parseJson(draft.unavailableJson, "unavailable routes"),
    prices: parseJson(draft.pricesJson, "prices"),
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

const RouteRow = ({
  route,
  onChange,
  onRemove,
}: {
  readonly route: RouteSpec;
  readonly onChange: (next: RouteSpec) => void;
  readonly onRemove: () => void;
}) => (
  <div className="flex items-center gap-1 text-sm">
    <input
      aria-label="harness"
      className="w-24 h-8 rounded-md border border-input bg-background px-2 text-sm"
      value={route.harness}
      onChange={(e) => onChange({ ...route, harness: e.target.value })}
    />
    <input
      aria-label="model"
      className="w-56 h-8 rounded-md border border-input bg-background px-2 text-sm"
      value={route.model}
      onChange={(e) => onChange({ ...route, model: e.target.value })}
    />
    <select
      aria-label="effort"
      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
      value={route.effort ?? ""}
      onChange={(e) => {
        const { effort: _effort, ...rest } = route;
        onChange(
          e.target.value === "" ? rest : { ...rest, effort: EffortSchema.parse(e.target.value) },
        );
      }}
    >
      <option value="">(default effort)</option>
      {EffortSchema.options.map((effort) => (
        <option key={effort} value={effort}>
          {effort}
        </option>
      ))}
    </select>
    <button type="button" className="text-xs underline" onClick={onRemove}>
      remove
    </button>
  </div>
);

const Ladders = ({
  ladders,
  onChange,
}: {
  readonly ladders: RoutingPolicy["ladders"];
  readonly onChange: (next: RoutingPolicy["ladders"]) => void;
}) => (
  <div className="flex flex-col gap-3">
    {Object.entries(ladders).map(([name, rungs]) => (
      <fieldset key={name} className="rounded-lg border p-3">
        <legend className="px-1 font-medium">{name}</legend>
        {rungs.map((rung, r) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rungs are positional and edited by position
          <div key={`${name}-${r}`} className="mb-2 ml-2">
            <div className="flex items-center gap-2 text-sm">
              <select
                aria-label={`${name} rung ${r + 1} tier`}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                value={rung.tier}
                onChange={(e) =>
                  onChange({
                    ...ladders,
                    [name]: rungs.map((x, i) =>
                      i === r ? { ...x, tier: TierSchema.parse(e.target.value) } : x,
                    ),
                  })
                }
              >
                {TierSchema.options.map((tier) => (
                  <option key={tier} value={tier}>
                    {tier}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="text-xs underline"
                onClick={() =>
                  onChange({
                    ...ladders,
                    [name]: rungs.map((x, i) =>
                      i === r ? { ...x, routes: [...x.routes, { harness: "", model: "" }] } : x,
                    ),
                  })
                }
              >
                add route
              </button>
              <button
                type="button"
                className="text-xs underline"
                onClick={() => onChange({ ...ladders, [name]: rungs.filter((_, i) => i !== r) })}
              >
                remove rung
              </button>
            </div>
            {rung.routes.map((route, i) => (
              <RouteRow
                // biome-ignore lint/suspicious/noArrayIndexKey: routes are positional and edited by position
                key={`${name}-${r}-${i}`}
                route={route}
                onChange={(next) =>
                  onChange({
                    ...ladders,
                    [name]: rungs.map((x, ri) =>
                      ri === r
                        ? { ...x, routes: x.routes.map((y, yi) => (yi === i ? next : y)) }
                        : x,
                    ),
                  })
                }
                onRemove={() =>
                  onChange({
                    ...ladders,
                    [name]: rungs.map((x, ri) =>
                      ri === r ? { ...x, routes: x.routes.filter((_, yi) => yi !== i) } : x,
                    ),
                  })
                }
              />
            ))}
          </div>
        ))}
        <button
          type="button"
          className="ml-2 text-xs underline"
          onClick={() =>
            onChange({
              ...ladders,
              [name]: [...rungs, { tier: "frontier", routes: [{ harness: "", model: "" }] }],
            })
          }
        >
          add rung
        </button>
      </fieldset>
    ))}
  </div>
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
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div>
          <h2 className="mb-1 font-semibold">Examination policy</h2>
          <table className="text-sm">
            <thead>
              <tr>
                <th className="p-1 text-left">Risk</th>
                {REQUIREMENTS.map(([key, label]) => (
                  <th key={key} className="p-1 text-left font-normal">
                    {label}
                  </th>
                ))}
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h2 className="mb-1 font-semibold">Ladders</h2>
          <Ladders
            ladders={draft.ladders}
            onChange={(ladders) => setDraft({ ...draft, ladders })}
          />
        </div>

        {(
          [
            ["rulesJson", "Rules", "first match wins; the last must match everything"],
            ["unavailableJson", "Unavailable routes", "routes the ladders may not use right now"],
            ["pricesJson", "Prices", "per model, dollars per million tokens"],
          ] as const
        ).map(([key, label, hint]) => (
          <div key={key}>
            <h2 className="mb-1 font-semibold">{label}</h2>
            <p className="mb-1 text-xs text-muted-foreground">{hint}</p>
            <textarea
              aria-label={label}
              className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
              rows={8}
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </div>
        ))}

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
