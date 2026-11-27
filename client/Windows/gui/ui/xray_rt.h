#ifndef PB_UI_XRAY_RT_H
#define PB_UI_XRAY_RT_H

/*
 * REMNA-PERUSER-XRAY-1: local per-user Xray core runtime.
 *
 * The PEC server delivers an "xrayRuntime" block in /api/app/sync containing
 * the rendered per-user Xray config, the derived localhost listener port and
 * the pinned core version. This module:
 *   - ensures the pinned xray binary is present (downloaded from the PEC
 *     server fleet endpoint, sha256-verified),
 *   - atomically writes the config file under %LOCALAPPDATA%\PEC-App\xray,
 *   - spawns / restarts / supervises "xray.exe run -config ..." and
 *   - stops the core whenever the server disables the runtime.
 *
 * Called from the PecSync worker thread only (single-threaded contract), so
 * no locking beyond the process handle is required.
 */

#include <wincrypt.h>
#include <shellapi.h>
#include <shlobj.h>

/* Defined in pec_sync.h (which includes this header); needed by
 * PecXrayBuildStatusJson below. */
static void PecJsonEscapeString(const char* src, char* dst, size_t dstSize);

#ifndef CALG_SHA_256
#define CALG_SHA_256 0x0000800c
#endif

static void PecXrayU8W(const char* s, wchar_t* out, int cch)
{
    if (!out || cch <= 0) return;
    out[0] = 0;
    if (!s || !*s) return;
    if (MultiByteToWideChar(CP_UTF8, 0, s, -1, out, cch) == 0) out[cch - 1] = 0;
}

typedef struct {
    BOOL     enabled;
    wchar_t  version[32];
    int      listenPort;
    int      socksPort;
    wchar_t  proxyUser[128];
    wchar_t  proxyPass[128];
    DWORD    cfgHash;
    wchar_t  exePath[MAX_PATH];
    wchar_t  cfgPath[MAX_PATH];
    HANDLE   hProc;
    DWORD    procId;
    DWORD    lastStartTick;
    BOOL     stopRequested;
    /* UI-visible status (XRAY-STATUS-UI-1): server fail-closed reason,
     * subscription server count and a local lifecycle note. Written by the
     * PecSync worker, read by the UI thread through PecXrayGetSnapshot. */
    wchar_t  reason[64];
    wchar_t  note[64];
    int      serverCount;
    DWORD    lastApplyTick;
} PecXrayState;

static PecXrayState g_xray = { 0 };

/* Lock guarding g_xray status fields between the sync worker and the UI
 * thread. Lazy one-shot init: 0 = none, 1 = initializing, 2 = ready. */
static CRITICAL_SECTION g_xrayLock;
static LONG g_xrayLockState = 0;

static void PecXrayLockEnter(void)
{
    LONG st = InterlockedCompareExchange(&g_xrayLockState, 1, 0);
    if (st == 0) {
        InitializeCriticalSection(&g_xrayLock);
        InterlockedExchange(&g_xrayLockState, 2);
    } else if (st == 1) {
        while (InterlockedCompareExchange(&g_xrayLockState, 2, 2) != 2)
            Sleep(1);
    }
    EnterCriticalSection(&g_xrayLock);
}

static void PecXrayLockLeave(void)
{
    LeaveCriticalSection(&g_xrayLock);
}

typedef struct {
    BOOL     enabled;
    BOOL     running;
    wchar_t  version[32];
    int      listenPort;
    int      socksPort;
    wchar_t  proxyUser[128];
    wchar_t  reason[64];
    wchar_t  note[64];
    int      serverCount;
    DWORD    procId;
} PecXraySnapshot;

/* Thread-safe UI snapshot. Never blocks on the process object. */
static void PecXrayGetSnapshot(PecXraySnapshot* out)
{
    if (!out) return;
    ZeroMemory(out, sizeof(*out));
    PecXrayLockEnter();
    out->enabled = g_xray.enabled;
    out->running = FALSE;
    if (g_xray.hProc) {
        DWORD code = 0;
        if (GetExitCodeProcess(g_xray.hProc, &code) && code == STILL_ACTIVE) {
            out->running = TRUE;
            out->procId = g_xray.procId;
        }
    }
    lstrcpynW(out->version, g_xray.version, 32);
    out->listenPort = g_xray.listenPort;
    out->socksPort = g_xray.socksPort;
    lstrcpynW(out->proxyUser, g_xray.proxyUser, 128);
    lstrcpynW(out->reason, g_xray.reason, 64);
    lstrcpynW(out->note, g_xray.note, 64);
    out->serverCount = g_xray.serverCount;
    PecXrayLockLeave();
}

/* JSON fragment appended to the /api/app/sync body (empty string when the
 * runtime never activated). Values are fixed-shape; server sanitizes again. */
static void PecXrayBuildStatusJson(char* out, int cch)
{
    if (!out || cch <= 0) return;
    out[0] = 0;
    PecXraySnapshot s;
    PecXrayGetSnapshot(&s);
    if (!s.enabled && !s.running && !s.reason[0]) return;
    char ver[40] = { 0 }, rsn[80] = { 0 };
    WideCharToMultiByte(CP_UTF8, 0, s.version, -1, ver, sizeof(ver), NULL, NULL);
    WideCharToMultiByte(CP_UTF8, 0, s.reason, -1, rsn, sizeof(rsn), NULL, NULL);
    char verEsc[96] = { 0 }, rsnEsc[160] = { 0 };
    PecJsonEscapeString(ver, verEsc, sizeof(verEsc));
    PecJsonEscapeString(rsn, rsnEsc, sizeof(rsnEsc));
    _snprintf_s(out, cch, _TRUNCATE,
        ",\"xrayStatus\":{\"enabled\":%s,\"running\":%s,\"version\":\"%s\",\"socksPort\":%d,\"reason\":\"%s\",\"serverCount\":%d}",
        s.enabled ? "true" : "false", s.running ? "true" : "false",
        verEsc, s.socksPort, rsnEsc, s.serverCount);
}

static void PecXrayDir(wchar_t* out, int cch)
{
    wchar_t appdata[MAX_PATH] = { 0 };
    if (!GetEnvironmentVariableW(L"APPDATA", appdata, MAX_PATH)) appdata[0] = 0;
    _snwprintf_s(out, cch, _TRUNCATE, L"%s\\PEC-App\\xray", appdata);
}

static DWORD PecXrayFnv1a(const char* s)
{
    DWORD h = 2166136261u;
    for (; s && *s; s++) { h ^= (unsigned char)*s; h *= 16777619u; }
    return h;
}

/* Serialize a parsed JVal subtree back to compact JSON text. Returns a
 * malloc'd buffer the caller must free, or NULL on allocation failure. */
static void PecXrayDumpJson(StrBuf* b, const JVal* v)
{
    if (!v) { sb_put(b, "null"); return; }
    switch (v->type) {
    case J_NULL: sb_put(b, "null"); break;
    case J_BOOL: sb_put(b, v->bval ? "true" : "false"); break;
    case J_NUM: {
        char tmp[40];
        double d = v->nval;
        if (d == (double)(long long)d && d >= -1e15 && d <= 1e15)
            _snprintf_s(tmp, sizeof(tmp), _TRUNCATE, "%lld", (long long)d);
        else
            _snprintf_s(tmp, sizeof(tmp), _TRUNCATE, "%.17g", d);
        sb_put(b, tmp);
        break;
    }
    case J_STR: sb_json_str(b, v->sval ? v->sval : ""); break;
    case J_ARR: {
        const JVal* c;
        sb_put(b, "[");
        for (c = v->child; c; c = c->next) {
            PecXrayDumpJson(b, c);
            if (c->next) sb_put(b, ",");
        }
        sb_put(b, "]");
        break;
    }
    case J_OBJ: {
        const JVal* c;
        sb_put(b, "{");
        for (c = v->child; c; c = c->next) {
            sb_json_str(b, c->key ? c->key : "");
            sb_put(b, ":");
            PecXrayDumpJson(b, c);
            if (c->next) sb_put(b, ",");
        }
        sb_put(b, "}");
        break;
    }
    }
}

static void PecXrayStopProcess(void)
{
    if (g_xray.hProc) {
        TerminateProcess(g_xray.hProc, 1);
        WaitForSingleObject(g_xray.hProc, 3000);
        CloseHandle(g_xray.hProc);
        PecXrayLockEnter();
        g_xray.hProc = NULL;
        g_xray.procId = 0;
        PecXrayLockLeave();
        PB_WriteAppLog("PecXray: local core stopped");
    }
}

static BOOL PecXrayVersionOkW(const wchar_t* v)
{
    size_t len = wcslen(v);
    size_t i;
    int dots = 0;
    if (len == 0 || len > 24) return FALSE;
    for (i = 0; i < len; i++) {
        if (v[i] == L'.') { dots++; continue; }
        if (v[i] < L'0' || v[i] > L'9') return FALSE;
    }
    return dots == 2;
}

static BOOL PecXrayVerifySha256(const wchar_t* filePath, const wchar_t* expectedHex)
{
    if (!filePath || !expectedHex || wcslen(expectedHex) != 64) return FALSE;
    HANDLE hFile = CreateFileW(filePath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return FALSE;

    BOOL result = FALSE;
    HCRYPTPROV hProv = 0;
    HCRYPTHASH hHash = 0;
    if (CryptAcquireContextW(&hProv, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)) {
        if (CryptCreateHash(hProv, CALG_SHA_256, 0, 0, &hHash)) {
            BYTE buf[16384];
            DWORD bytesRead = 0;
            BOOL readOk = TRUE;
            for (;;) {
                if (!ReadFile(hFile, buf, sizeof(buf), &bytesRead, NULL)) { readOk = FALSE; break; }
                if (bytesRead == 0) break;
                if (!CryptHashData(hHash, buf, bytesRead, 0)) { readOk = FALSE; break; }
            }
            if (readOk) {
                BYTE hashBytes[32];
                DWORD hashLen = sizeof(hashBytes);
                if (CryptGetHashParam(hHash, HP_HASHVAL, hashBytes, &hashLen, 0) && hashLen == 32) {
                    wchar_t hex[65];
                    for (DWORD i = 0; i < 32; i++)
                        _snwprintf_s(&hex[i * 2], 3, _TRUNCATE, L"%02x", hashBytes[i]);
                    hex[64] = 0;
                    result = (_wcsicmp(hex, expectedHex) == 0);
                }
            }
            CryptDestroyHash(hHash);
        }
        CryptReleaseContext(hProv, 0);
    }
    CloseHandle(hFile);
    return result;
}

/* Download xray-{version}.exe from the PEC server fleet endpoint into the
 * local cache. Same transport policy as PecSync: HTTPS or loopback only. */
static BOOL PecXrayDownloadBinary(const wchar_t* serverUrl, const wchar_t* fleetToken,
    const wchar_t* version, const wchar_t* destPath)
{
    URL_COMPONENTS uc;
    wchar_t host[256] = { 0 };
    wchar_t path[1024] = { 0 };
    ZeroMemory(&uc, sizeof(uc));
    uc.dwStructSize = sizeof(uc);
    uc.lpszHostName = host;
    uc.dwHostNameLength = 255;
    uc.lpszUrlPath = path;
    uc.dwUrlPathLength = 1023;
    if (!WinHttpCrackUrl(serverUrl, 0, 0, &uc)) return FALSE;

    BOOL isHttps = (uc.nScheme == INTERNET_SCHEME_HTTPS);
    BOOL isLoopback = (_wcsicmp(host, L"localhost") == 0 || _wcsicmp(host, L"127.0.0.1") == 0 ||
                       _wcsicmp(host, L"::1") == 0 || _wcsicmp(host, L"[::1]") == 0);
    if (!isHttps && !isLoopback) return FALSE;

    wchar_t dlPath[1280];
    {
        size_t pl = wcslen(path);
        while (pl > 0 && path[pl - 1] == L'/') path[--pl] = 0;
        _snwprintf_s(dlPath, 1280, _TRUNCATE, L"%s/api/xray-runtime/binaries/%s/download", path, version);
        if (dlPath[0] != L'/') {
            wchar_t tmp[1280];
            _snwprintf_s(tmp, 1280, _TRUNCATE, L"/%s", dlPath);
            lstrcpynW(dlPath, tmp, 1280);
        }
    }

    BOOL ok = FALSE;
    HINTERNET hSession = WinHttpOpen(L"PEC-App-Xray/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return FALSE;
    DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
    WinHttpSetOption(hSession, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));
    WinHttpSetTimeouts(hSession, 10000, 15000, 15000, 60000);

    HINTERNET hConnect = WinHttpConnect(hSession, host, uc.nPort, 0);
    if (hConnect) {
        HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"GET", dlPath, NULL,
            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, isHttps ? WINHTTP_FLAG_SECURE : 0);
        if (hRequest) {
            wchar_t hdrs[512];
            _snwprintf_s(hdrs, 512, _TRUNCATE, L"x-fleet-token: %ls\r\n", fleetToken);
            if (WinHttpSendRequest(hRequest, hdrs, (DWORD)wcslen(hdrs), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
                WinHttpReceiveResponse(hRequest, NULL))
            {
                DWORD status = 0, statusSize = sizeof(status);
                WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                    WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize, WINHTTP_NO_HEADER_INDEX);

                wchar_t shaHeader[128] = { 0 };
                DWORD shaSize = sizeof(shaHeader);
                WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_CUSTOM, L"X-Sha256",
                    shaHeader, &shaSize, WINHTTP_NO_HEADER_INDEX);

                if (status == 200) {
                    wchar_t tmpPath[MAX_PATH];
                    _snwprintf_s(tmpPath, MAX_PATH, _TRUNCATE, L"%s.tmp-%lu", destPath, GetCurrentThreadId());
                    HANDLE f = CreateFileW(tmpPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
                    if (f != INVALID_HANDLE_VALUE) {
                        BOOL ioOk = TRUE;
                        DWORD total = 0;
                        char buf[65536];
                        DWORD avail = 0;
                        while (WinHttpQueryDataAvailable(hRequest, &avail) && avail > 0) {
                            DWORD toRead = avail > sizeof(buf) ? (DWORD)sizeof(buf) : avail;
                            DWORD read = 0;
                            if (!WinHttpReadData(hRequest, buf, toRead, &read) || read == 0) { ioOk = FALSE; break; }
                            DWORD written = 0;
                            if (!WriteFile(f, buf, read, &written, NULL) || written != read) { ioOk = FALSE; break; }
                            total += read;
                            if (total > 80u * 1024u * 1024u) { ioOk = FALSE; break; }
                        }
                        CloseHandle(f);
                        if (ioOk && total >= 1024u * 1024u &&
                            PecXrayVerifySha256(tmpPath, shaHeader))
                        {
                            if (MoveFileExW(tmpPath, destPath, MOVEFILE_REPLACE_EXISTING)) ok = TRUE;
                        }
                        if (!ok) DeleteFileW(tmpPath);
                    }
                }
            }
            WinHttpCloseHandle(hRequest);
        }
        WinHttpCloseHandle(hConnect);
    }
    WinHttpCloseHandle(hSession);
    return ok;
}

static BOOL PecXrayWriteConfig(const wchar_t* cfgPath, const char* jsonText)
{
    wchar_t tmpPath[MAX_PATH];
    _snwprintf_s(tmpPath, MAX_PATH, _TRUNCATE, L"%s.tmp-%lu", cfgPath, GetCurrentThreadId());
    HANDLE f = CreateFileW(tmpPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return FALSE;
    DWORD written = 0;
    BOOL ok = WriteFile(f, jsonText, (DWORD)strlen(jsonText), &written, NULL) && written == (DWORD)strlen(jsonText);
    CloseHandle(f);
    if (!ok) { DeleteFileW(tmpPath); return FALSE; }
    if (!MoveFileExW(tmpPath, cfgPath, MOVEFILE_REPLACE_EXISTING)) { DeleteFileW(tmpPath); return FALSE; }
    return TRUE;
}

static BOOL PecXraySpawn(void)
{
    if (!g_xray.exePath[0] || !g_xray.cfgPath[0]) return FALSE;
    wchar_t cmd[MAX_PATH * 2 + 64];
    _snwprintf_s(cmd, ARRAYSIZE(cmd), _TRUNCATE, L"\"%s\" run -config \"%s\"", g_xray.exePath, g_xray.cfgPath);

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, cmd, NULL, NULL, FALSE,
        CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, NULL, NULL, &si, &pi))
    {
        PB_WriteAppLog("PecXray: CreateProcessW failed (err %lu)", GetLastError());
        return FALSE;
    }
    CloseHandle(pi.hThread);
    PecXrayLockEnter();
    g_xray.hProc = pi.hProcess;
    g_xray.procId = pi.dwProcessId;
    PecXrayLockLeave();
    g_xray.lastStartTick = GetTickCount();
    PB_WriteAppLog("PecXray: core started (pid %lu, port %d, v%ls)", pi.dwProcessId, g_xray.listenPort, g_xray.version);
    return TRUE;
}

static BOOL PecXrayProcessAlive(void)
{
    if (!g_xray.hProc) return FALSE;
    DWORD code = 0;
    if (GetExitCodeProcess(g_xray.hProc, &code) && code == STILL_ACTIVE) return TRUE;
    CloseHandle(g_xray.hProc);
    PecXrayLockEnter();
    g_xray.hProc = NULL;
    g_xray.procId = 0;
    PecXrayLockLeave();
    return FALSE;
}

/*
 * Entry point called from the PecSync worker after each successful sync.
 * blockJson is the raw "xrayRuntime" object from the response (may be NULL).
 */
static void PecXrayHandleSyncBlock(JVal* block, const wchar_t* serverUrl, const wchar_t* fleetToken)
{
    if (!block || block->type != J_OBJ || !json_bool(block, "enabled", 0)) {
        PecXrayLockEnter();
        /* Keep the server's fail-closed reason (user_not_found, ...) visible
         * in the UI even though the core stays off. */
        if (block && block->type == J_OBJ)
            PecXrayU8W(json_str(block, "reason", ""), g_xray.reason, 64);
        g_xray.enabled = FALSE;
        g_xray.serverCount = 0;
        g_xray.note[0] = 0;
        PecXrayLockLeave();
        if (g_xray.hProc) {
            PB_WriteAppLog("PecXray: runtime disabled by server - stopping core");
            PecXrayStopProcess();
        }
        return;
    }

    wchar_t version[32] = { 0 };
    PecXrayU8W(json_str(block, "version", ""), version, 32);
    if (version[0] == 0 || !PecXrayVersionOkW(version)) {
        PB_WriteAppLog("PecXray: server sent invalid core version - ignoring block");
        return;
    }
    long port = json_long(block, "listenPort", 0);
    JVal* cfg = json_get(block, "config");
    if (port < 1 || port > 65535 || !cfg || cfg->type != J_OBJ) {
        PB_WriteAppLog("PecXray: sync block incomplete (port=%ld, config=%d) - ignoring", port, cfg ? 1 : 0);
        return;
    }

    /* Count subscription servers from the block for the UI status card. */
    int srvCount = 0;
    {
        JVal* servers = json_get(block, "servers");
        if (servers && servers->type == J_ARR) {
            JVal* s;
            for (s = servers->child; s; s = s->next) srvCount++;
        }
    }

    StrBuf sb;
    sb_init(&sb);
    PecXrayDumpJson(&sb, cfg);
    if (!sb.buf) return;
    DWORD newHash = PecXrayFnv1a(sb.buf);

    wchar_t dir[MAX_PATH];
    PecXrayDir(dir, MAX_PATH);
    SHCreateDirectoryExW(NULL, dir, NULL);

    wchar_t exePath[MAX_PATH], cfgPath[MAX_PATH];
    _snwprintf_s(exePath, MAX_PATH, _TRUNCATE, L"%s\\xray-%s.exe", dir, version);
    _snwprintf_s(cfgPath, MAX_PATH, _TRUNCATE, L"%s\\config.json", dir);

    BOOL cfgChanged = (!g_xray.enabled || g_xray.cfgHash != newHash ||
                       wcscmp(g_xray.version, version) != 0 ||
                       wcscmp(g_xray.exePath, exePath) != 0);

    PecXrayLockEnter();
    lstrcpynW(g_xray.version, version, 32);
    g_xray.listenPort = (int)port;
    g_xray.socksPort = (int)json_long(block, "socksPort", port + 1);
    PecXrayU8W(json_str(block, "proxyUser", ""), g_xray.proxyUser, 128);
    PecXrayU8W(json_str(block, "proxyPass", ""), g_xray.proxyPass, 128);
    lstrcpynW(g_xray.exePath, exePath, MAX_PATH);
    lstrcpynW(g_xray.cfgPath, cfgPath, MAX_PATH);
    g_xray.enabled = TRUE;
    g_xray.reason[0] = 0;
    g_xray.serverCount = srvCount;
    PecXrayLockLeave();

    if (cfgChanged) {
        if (GetFileAttributesW(exePath) == INVALID_FILE_ATTRIBUTES) {
            PB_WriteAppLog("PecXray: fetching core binary v%ls from server", version);
            if (!PecXrayDownloadBinary(serverUrl, fleetToken, version, exePath)) {
                PB_WriteAppLog("PecXray: core binary download failed - will retry on next sync");
                PecXrayLockEnter();
                lstrcpynW(g_xray.note, L"binary_download_failed", 64);
                PecXrayLockLeave();
                sb_free(&sb);
                return;
            }
        }
        if (!PecXrayWriteConfig(cfgPath, sb.buf)) {
            PB_WriteAppLog("PecXray: config write failed");
            PecXrayLockEnter();
            lstrcpynW(g_xray.note, L"config_write_failed", 64);
            PecXrayLockLeave();
            sb_free(&sb);
            return;
        }
        g_xray.cfgHash = newHash;
        PecXrayStopProcess();
        if (PecXraySpawn()) {
            PecXrayLockEnter();
            g_xray.note[0] = 0;
            g_xray.lastApplyTick = GetTickCount();
            PecXrayLockLeave();
        }
    } else if (!PecXrayProcessAlive()) {
        // Supervise: restart a crashed core, but no more than once per 30s.
        DWORD now = GetTickCount();
        if (g_xray.lastStartTick == 0 || now - g_xray.lastStartTick > 30000) {
            PB_WriteAppLog("PecXray: core process exited - restarting");
            if (PecXraySpawn()) {
                PecXrayLockEnter();
                g_xray.note[0] = 0;
                PecXrayLockLeave();
            }
        }
    }
    sb_free(&sb);
}

static void PecXrayShutdown(void)
{
    g_xray.enabled = FALSE;
    PecXrayStopProcess();
}

#endif // PB_UI_XRAY_RT_H
