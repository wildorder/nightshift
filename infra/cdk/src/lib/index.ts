// AWS CDK v2 app. The sole IaC system (A-09).
export { NightshiftApiStack } from "./api-stack.js";
export { MonthlyCostBudget, type MonthlyCostBudgetProps } from "./budget.js";
export { DATA_EXPORT_KEYS, type DataExportKey, dataExportName } from "./data-exports.js";
export { NightshiftDataStack, NODE_INDEX_NAME } from "./data-stack.js";
export { NightshiftDnsStack } from "./dns-stack.js";
export {
  apiHostnameFor,
  CERTIFICATE_REGION,
  DEFAULT_HOSTNAMES_MODE,
  DEV_STAGE,
  HOSTNAMES_MODES,
  type HostnamesMode,
  NIGHTSHIFT_ACCOUNT,
  PARENT_ZONE_NAME,
  PRIMARY_REGION,
  parseHostnamesMode,
  STUDIO_DEV_ORIGIN,
  STUDIO_DEV_PORT,
  studioHostnameFor,
  studioOriginsFor,
  ZONE_NAME,
} from "./hostnames.js";
export {
  assertValidStage,
  DNS_EXPORT_KEYS,
  DNS_STACK_NAME,
  type DnsExportKey,
  dnsExportName,
  hostnamesModeOf,
  type NightshiftStackProps,
  type StackRole,
  stackNameFor,
} from "./stack-props.js";
export { composeNightshiftStacks, DEFAULT_STAGE, type NightshiftStacks } from "./stacks.js";
export {
  NightshiftStudioCertificateStack,
  type NightshiftStudioCertificateStackProps,
} from "./studio-cert-stack.js";
export {
  NightshiftStudioStack,
  type NightshiftStudioStackProps,
  resolveStudioAssets,
  STUDIO_CONFIG_KEY,
  STUDIO_DIST,
  STUDIO_PLACEHOLDER,
  type StudioConfig,
} from "./studio-stack.js";
