/**
 * Managed storage schema. Declares every key background.js actually reads -
 * previously `targetGroup` was read at runtime but never declared, so
 * group-based routing silently failed on GPO deployments.
 *
 * EXT-SCHEMA-ESCAPE-1: the JSON artifact must carry the VALID escape
 * "DOMAIN\\username" (two backslash characters) in the domainUser
 * description - a single "\u" would be read by the browser as a
 * unicode-escape prefix -> "Invalid package" -> Edge rejects every fresh
 * install/update of the extension. Inside this TS template literal the
 * valid artifact escape is written as FOUR backslashes
 * (DOMAIN\\\\\\\\username in the raw source below).
 */
export const MANAGED_SCHEMA_TEMPLATE = `{
  "type": "object",
  "properties": {
    "extToken": {
      "type": "string",
      "description": "Shared corporate token for authentication on the mini-server (via X-Ext-Token header)."
    },
    "credsUrl": {
      "type": "string",
      "description": "Direct URL for /creds endpoint. Defaults to the build-configured server URL + /creds."
    },
    "syncUrl": {
      "type": "string",
      "description": "URL for /api/sync endpoint to receive dynamic proxy configuration and send heartbeat."
    },
    "autoConfigureProxy": {
      "type": "boolean",
      "description": "If true (or DWORD 1 via GPO), extension manages chrome.proxy.settings dynamically according to the mini-server config."
    },
    "targetGroup": {
      "type": "string",
      "description": "Fleet group this device belongs to (used for group-scoped routing profiles)."
    },
    "domainUser": {
      "type": "string",
      "description": "Active Directory domain user identity (e.g. DOMAIN\\\\\\\\username) delivered via GPO / GPP."
    }
  }
}
`;
