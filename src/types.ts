export interface ProxyCredentials {
  user: string;
  pass: string;
  updatedAt?: string;
}

export type ProxyProtocol = "http" | "https" | "socks5" | "pac" | "direct";

export type RoutingAction = "proxy" | "direct" | "block";
export type RuleTargetType = "domain" | "wildcard" | "cidr" | "preset";

export interface RoutingRule {
  id: string;
  name: string;
  targetType: RuleTargetType;
  pattern: string; // e.g. "*.openai.com", "10.0.0.0/8", "preset:ai_services"
  action: RoutingAction;
  enabled: boolean;
  notes?: string;
}

export interface GeoPreset {
  id: string;
  name: string;
  category: "ai" | "social" | "ru" | "internal" | "security" | "diagnostics";
  description: string;
  domains: string[];
}

/**
 * GEO-PRESET-UX-2: preset composition layers. `sources` is the authoritative
 * per-preset model; the flat `entries`/`domains` fields remain derived
 * projections (materialized union of the layers in order) so the PAC contract
 * stays a plain string list.
 *
 * - geo-tag: live reference to a builtin GEO_PRESETS entry (ref = preset id).
 * - url:     remote list; `entries` caches the last fetched snapshot (refresh
 *            re-downloads only this layer).
 * - file:    uploaded geodata. GEO-BUILDER-UX-3: uploads are stored
 *            content-addressed (data/geofiles/<sha256>.dat) and the layer
 *            becomes LIVE ({fileId, fileName, tags[]}) — materialization
 *            re-reads the file and re-parses by tags. `entries` remains the
 *            fallback snapshot for legacy layers without fileId (old layers
 *            are snapshots by definition) and for import round-trips where
 *            the target server does not hold the same file.
 * - manual:  hand-typed entries (constructor textarea / "+ Domain" input).
 */
export type PresetSource =
  | { kind: "geo-tag"; ref: string; entries?: string[] }
  | { kind: "url"; url: string; tag?: string; entries?: string[]; lastUpdated?: string }
  | {
      kind: "file";
      name?: string;
      tag?: string;
      tags?: string[];
      fileId?: string;
      fileName?: string;
      entries: string[];
    }
  | { kind: "manual"; entries: string[] };

export interface RoutingPresetItem {
  id: string;
  name: string;
  category: string;
  description: string;
  type: "domain" | "cidr";
  source: "builtin" | "remote" | "file";
  sourceUrl?: string;
  sourceTag?: string;
  lastUpdated?: string;
  domains?: string[];
  entries: string[];
  sources?: PresetSource[];
}


export interface RoutingProfile {
  id: string;
  name: string;
  description: string;
  defaultPolicy: "direct" | "proxy"; // "direct": bypass all by default, proxy only matching. "proxy": tunnel all, direct only exceptions.
  failClosed?: boolean; // When true, omit '; DIRECT' fallback to prevent IP leak when proxy is down
  rules: RoutingRule[];
  targetScope: "all" | "group" | "instances";
  targetGroup?: string;
  targetInstanceIds?: string[];
  isDefault?: boolean;
  colorPalette?: string;
  uiLayout?: string;
  defaultThemeMode?: "light" | "dark";
  themeColor?: string;
  themeBackground?: string;
  themeCard?: string;
  updatedAt: string;
}

export interface ProxyConfiguration {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  bypassList: string[];
  pacScript: string;
  pacUrl: string;
  syncIntervalMs: number;
  killSwitch: boolean;
  activeProfileId?: string;
  routingMode?: "pac" | "fixed";
  updatedAt: string;
}

export interface ExtensionInstance {
  instanceId: string;
  ip: string;
  version: string;
  extensionId?: string;
  userAgent?: string;
  browser?: string;
  lastSync: string;
  syncCount: number;
  status: "ONLINE" | "STALE" | "OFFLINE";
  activeProxyMode?: string;
  group?: string;
  assignedProfileId?: string;
  appliedProfileName?: string;
  assignedProxyId?: string;
  appliedProxyName?: string;
  tokenHash?: string;
  enrolledAt?: string;
  revoked?: boolean;
  revokedReason?: string;
  username?: string;
  domainUser?: string;
  isLegacy?: boolean;
  pairedAppId?: string;
  pairedHostname?: string;
  verifiedByApp?: boolean;
}

export interface GpoConfig {
  allowlistEntry: string;
  allowlistIndex: number;
  installSourcesEntry: string;
  extensionSettingsJson: Record<string, any>;
  extensionSettingsEntries: Record<string, Record<string, any>>;
  regContent: string;
  regContentUser: string;
  regContentMachine: string;
  readmeContent: string;
}

export interface RotationConfig {
  enabled: boolean;
  intervalMinutes: number;
  panelUrl: string;
  adminUser: string;
  adminPass: string;
  /** Remnawave user whose credentials are rotated (replaces the 3x-ui inbound remark). */
  targetUsername: string;
  panelId?: string;
  insecureSkipVerify: boolean;
  lastRotatedAt?: string;
  nextRotationAt?: string;
  lastStatus?: string;
  lastError?: string;
}

export interface PanelRemnawaveConfig {
  id: string;
  name: string;
  panelUrl: string;
  /** Remnawave API token sent as a Bearer credential. */
  apiToken?: string;
  /** Legacy login credentials retained for existing panel configurations. */
  adminUser?: string;
  adminPass?: string;
  insecureTls?: boolean;
  rotationEnabled?: boolean;
  /** Remnawave username rotated by this panel entry (was targetRemark for 3x-ui). */
  targetUsername?: string;
  rotationIntervalMinutes?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface RotationHistoryItem {
  id: string;
  timestamp: string;
  source: "remnawave" | "standalone-atomic" | "manual";
  user: string;
  success: boolean;
  error?: string;
}

export interface ExtensionBuildConfig {
  name: string;
  shortName: string;
  version: string;
  description?: string;
  serverUrl?: string;
  updateUrl?: string;
  token?: string;
  locale?: "ru" | "en";
  uiMode?: "popup" | "stealth";
  presetTemplate?: "self-service-pro" | "enterprise-invisible";
  presetStyle?: "cyber-blue" | "dark-obsidian" | "nordic-arctic" | "emerald-secops" | "enterprise-light" | "emerald-sentinel" | "sunset-amber" | "minimal-light";
  uiLayout?: "console" | "terminal";
  colorPalette?: "cyber" | "obsidian" | "nord" | "emerald" | "amber" | "light";
  defaultThemeMode?: "dark" | "light";
  themeColor?: string;
  themeBackground?: string;
  themeCard?: string;
  // THEME-WEB-1: E2E "Sync theme with extensions & apps" toggle. Absent/true
  // keeps the legacy behavior (corporate theme ships in artifacts); explicit
  // false stops the server from pushing the theme block.
  themeSyncEnabled?: boolean;
  iconEmoji?: string;
  customIconDataUrl?: string;
  iconType?: "shield" | "lock" | "globe" | "bolt" | "server" | "key";
  webRtcProtection?: boolean;
  dnsLeakProtection?: boolean;
  badgeIndicator?: boolean;
  allowUserBypass?: boolean;
  bypassAutoTimeoutMinutes?: number;
  showIpGeoChecker?: boolean;
  showSupportButton?: boolean;
  supportUrl?: string;
  pingTestUrl?: string;
  syncIntervalMinutes?: number;
  defaultServerUrl?: string;
  defaultToken?: string;
  targetProfileId?: string;
  defaultProxyId?: string;
  allowUserProxySwitch?: boolean;
  autoConfigureProxy?: boolean;
  targetGroup?: string;
  /** Source files manually edited in the Studio; regeneration never clobbers them. */
  overriddenFiles?: string[];
}

export interface ExtensionBuildInfo {
  extensionId: string;
  version: string;
  name: string;
  hasPrivateKey: boolean;
  crxExists: boolean;
  zipExists: boolean;
  updatesXmlExists: boolean;
  unpackedExists?: boolean;
  unpackedPath?: string;
  lastPackTime?: string;
  uiMode?: "stealth" | "popup";
  zipPath?: string;
  crxPath?: string;
  xmlPath?: string;
  buildLog?: string[];
  codeSigningStatus?: {
    isSigned: boolean;
    subject?: string;
    issuer?: string;
    type?: string;
  };
}

export interface ProxyCheckResult {
  id: string;
  status: "ONLINE" | "OFFLINE" | "ERROR" | "TIMEOUT";
  latencyMs: number;
  egressIp?: string;
  geoCountry?: string;
  checkedAt: string;
  error?: string;
}

export interface ProxyNode {
  id: string;                      // Unique ID (crypto.randomBytes(4).toString("hex") or uuid)
  tag: string;                     // Inbound tag or manual custom tag
  name: string;                    // Friendly display name
  type: "remnawave" | "manual";    // Source type
  panelId?: string;                // Reference to PanelRemnawaveConfig.id
  remnawaveUsername?: string;      // Remnawave user backing this node
  protocol: "socks5" | "http" | "https";
  host: string;                    // Proxy IP or FQDN
  port: number;                    // Listen port (1-65535)
  username?: string;               // Auth username
  password?: string;               // Auth password
  isActive: boolean;               // If true, feeds PAC and active creds
  enabled?: boolean;                // If false, node is disabled
  lastSync?: string;               // ISO timestamp of last sync / rotation
  status?: "OK" | "ERROR" | "IDLE" | "ONLINE" | "OFFLINE" | "TIMEOUT" | "CHECKING";
  latencyMs?: number;
  egressIp?: string;
  geoCountry?: string;
  lastCheck?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppProcessRule {
  id: string;
  processName: string;   // e.g. "chrome.exe", "curl.exe", "*"
  targetDomains?: string;// e.g. "*.youtube.com; *.instagram.com; *.corp.local"
  targetHosts?: string;  // e.g. "github.com; *.google.com; 192.168.*.*"
  targetPorts?: string;  // e.g. "80; 443; 8080"
  protocol: "tcp" | "udp" | "both";
  action: "proxy" | "direct" | "block";
}

export interface AppBuildConfig {
  name: string;
  shortName: string;
  version: string;
  description: string;
  presetStyle: "cyber-blue" | "dark-obsidian" | "nordic-arctic" | "emerald-secops" | "enterprise-light" | "emerald-sentinel" | "sunset-amber" | "minimal-light";
  uiLayout?: "console" | "terminal";
  defaultThemeMode: "dark" | "light";
  themeColor: string;
  themeBackground: string;
  themeCard: string;
  // THEME-WEB-1: see ExtensionBuildConfig.themeSyncEnabled
  themeSyncEnabled?: boolean;
  iconType: "shield" | "lock" | "globe" | "server" | "key";
  customIconDataUrl?: string;
  defaultServerUrl: string;
  defaultToken: string;
  syncIntervalMinutes: number;
  autoStartWithWindows: boolean;
  startMinimizedToTray: boolean;
  installAsService: boolean;
  trafficLogging: boolean;
  legacyWin7?: boolean;
  defaultProxyId: string;
  inheritRoutingProfileId?: string;
  includeExtensionRules?: boolean;
  inheritRuleIds?: string[];
  processRules: AppProcessRule[];
  updatedAt?: string;
}

export interface ToolchainDiagnostics {
  available: boolean;
  compilerName: string;
  compilerVersion?: string;
  hasGcc: boolean;
  hasGxx: boolean;
  hasWindres: boolean;
  hasWixl: boolean;
  hasMakensis: boolean;
  tools?: {
    gcc?: { available: boolean; version?: string };
    windres?: { available: boolean };
    wixl?: { available: boolean; version?: string };
    makensis?: { available: boolean };
  };
  gcc?: { available: boolean; version?: string };
  windres?: { available: boolean };
  wixl?: { available: boolean; version?: string };
}

export interface AppBuildInfo {
  version: string;
  builtAt: string;
  embeddedVersion?: string;
  binariesStale?: boolean;
  compilerStatus?: {
    compiled: boolean;
    compilerName: string;
    error?: string;
  };
  toolchain?: ToolchainDiagnostics;
  coreModulesIntegrity?: {
    name: string;
    sha256: string;
    size: number;
    present: boolean;
    verified: boolean;
  }[];
  windowsPackageUrl: string;
  windowsPackageSize: number;
  windowsPackageSha256: string;
  windowsInstallerUrl?: string;
  windowsInstallerSize?: number;
  windowsInstallerSha256?: string;
  windowsMsiUrl?: string;
  windowsMsiSize?: number;
  windowsMsiSha256?: string;
  linuxPackageUrl: string;
  linuxPackageSize: number;
  linuxPackageSha256: string;
  profilePath: string;
  buildLog?: string[];
  codeSigningStatus?: {
    isSigned: boolean;
    subject?: string;
    issuer?: string;
    type?: string;
  };
}

export interface DesktopInstance {
  appInstanceId: string;
  hostname: string;
  username: string;
  os?: string;
  version: string;
  clientType?: string;
  ip: string;
  lastSync: string;
  status: "ONLINE" | "STALE" | "OFFLINE";
  assignedProxyId?: string;
  appliedProxyName?: string;
  pairedExtension?: {
    instanceId: string;
    browser?: string;
  };
}

export interface ReleaseItem {
  id: string;
  type: "extension" | "app";
  version: string;
  builtAt: string;
  sha256: string;
  fileName: string;
  filePath: string;
  isActive: boolean;
  notes?: string;
  size?: number;
}

export interface ReleasesMetaStore {
  activeExtensionVersion?: string;
  activeAppVersion?: string;
  releases: ReleaseItem[];
}

