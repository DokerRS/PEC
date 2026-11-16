// ui/update_core.h - GUI-agnostic update download & verification pipeline shared by
// the classic GUI (main.c via ui/update.h) and the ImGui GUI (main_imgui.cpp).
// Security contract (AUDIT-NAT-1): a server-controlled update.downloadUrl must never
// be handed directly to the OS shell. It may only enter this pipeline as http(s),
// is downloaded via WinHTTP (UpdOpenGet additionally rejects plain http except
// loopback), gets verified by SHA-256 and Authenticode, and only the verified local
// file is executed.
// Unity-build header: requires profile/profile.h context (PB_WriteAppLog).
#ifndef PB_UI_UPDATE_CORE_H
#define PB_UI_UPDATE_CORE_H

#include <winhttp.h>
#include <wincrypt.h>
#include <softpub.h>
#include <wintrust.h>
#include "../profile/profile.h"
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "wintrust.lib")

#ifndef WM_APP_DLPROG
#define WM_APP_DLPROG  (WM_APP + 7)   // download worker -> dialog (percent)
#endif

#ifndef PB_UPD_INFO_DEFINED
#define PB_UPD_INFO_DEFINED
typedef struct {
    BOOL    available;
    wchar_t latest[32];
    wchar_t download[512];
    wchar_t notes[512];
    wchar_t date[32];
    wchar_t sha256[65];
} UpdInfo;
#endif

static void U8W(const char* s, wchar_t* out, int cch)
{
    if (!out || cch <= 0) return;
    int res = MultiByteToWideChar(CP_UTF8, 0, s ? s : "", -1, out, cch);
    if (res == 0) out[cch - 1] = L'\0';
    else out[res < cch ? res : (cch - 1)] = L'\0';
}

#ifndef CALG_SHA_256
#define CALG_SHA_256 0x0000800c
#endif

static BOOL UpdVerifyFileSha256(const wchar_t* filePath, const wchar_t* expectedSha256)
{
    if (!filePath || !expectedSha256 || wcslen(expectedSha256) != 64) return FALSE;

    HANDLE hFile = CreateFileW(filePath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL);
    if (hFile == INVALID_HANDLE_VALUE) return FALSE;

    HCRYPTPROV hProv = 0;
    HCRYPTHASH hHash = 0;
    BOOL result = FALSE;

    if (CryptAcquireContextW(&hProv, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT))
    {
        if (CryptCreateHash(hProv, CALG_SHA_256, 0, 0, &hHash))
        {
            BYTE buf[16384];
            DWORD bytesRead = 0;
            BOOL readOk = FALSE;
            for (;;)
            {
                BOOL rf = ReadFile(hFile, buf, sizeof(buf), &bytesRead, NULL);
                if (!rf) { readOk = FALSE; break; }
                if (bytesRead == 0) { readOk = TRUE; break; }
                if (!CryptHashData(hHash, buf, bytesRead, 0)) { readOk = FALSE; break; }
            }

            if (readOk)
            {
                BYTE hashBytes[32];
                DWORD hashLen = sizeof(hashBytes);
                if (CryptGetHashParam(hHash, HP_HASHVAL, hashBytes, &hashLen, 0) && hashLen == 32)
                {
                    wchar_t hexStr[65];
                    for (DWORD i = 0; i < 32; i++)
                    {
                        _snwprintf_s(&hexStr[i * 2], 3, _TRUNCATE, L"%02x", hashBytes[i]);
                    }
                    hexStr[64] = L'\0';

                    if (_wcsicmp(hexStr, expectedSha256) == 0)
                    {
                        result = TRUE;
                    }
                }
            }
            CryptDestroyHash(hHash);
        }
        CryptReleaseContext(hProv, 0);
    }
    CloseHandle(hFile);
    return result;
}

static BOOL UpdVerifyAuthenticode(const wchar_t* filePath)
{
    if (!filePath || !*filePath) return FALSE;

    WINTRUST_FILE_INFO fileInfo;
    ZeroMemory(&fileInfo, sizeof(fileInfo));
    fileInfo.cbStruct = sizeof(fileInfo);
    fileInfo.pcwszFilePath = filePath;

    WINTRUST_DATA trustData;
    ZeroMemory(&trustData, sizeof(trustData));
    trustData.cbStruct = sizeof(trustData);
    trustData.dwUIChoice = WTD_UI_NONE;
    trustData.fdwRevocationChecks = WTD_REVOKE_NONE;
    trustData.dwUnionChoice = WTD_CHOICE_FILE;
    trustData.pFile = &fileInfo;
    trustData.dwStateAction = WTD_STATEACTION_VERIFY;

    GUID policyGuid = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    LONG status = WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &policyGuid, &trustData);

    trustData.dwStateAction = WTD_STATEACTION_CLOSE;
    WinVerifyTrust((HWND)INVALID_HANDLE_VALUE, &policyGuid, &trustData);

    return (status == ERROR_SUCCESS);
}

// Only http(s) URLs may enter the update pipeline: blocks file:, ftp:, UNC paths
// and other scheme handlers before they reach WinHTTP or the shell (AUDIT-NAT-1).
static BOOL UpdIsHttpUrl(const wchar_t* url)
{
    if (!url) return FALSE;
    if (wcsncmp(url, L"https://", 8) == 0) return TRUE;
    if (wcsncmp(url, L"http://", 7) == 0) return TRUE;
    return FALSE;
}

// Open a GET request and read the response headers. On success returns the request handle
// and hands back the session/connection handles for cleanup; NULL on any failure.
static HINTERNET UpdOpenGet(const wchar_t* url, HINTERNET* sOut, HINTERNET* cOut)
{
    *sOut = *cOut = NULL;
    URL_COMPONENTS uc; wchar_t host[256] = {0}, path[2048] = {0};
    ZeroMemory(&uc, sizeof(uc)); uc.dwStructSize = sizeof(uc);
    uc.lpszHostName = host; uc.dwHostNameLength = 255;
    uc.lpszUrlPath = path; uc.dwUrlPathLength = 2047;
    if (!WinHttpCrackUrl(url, 0, 0, &uc)) return NULL;
    BOOL https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
    if (!https)
    {
        BOOL isLocal = (_wcsicmp(host, L"127.0.0.1") == 0 || _wcsicmp(host, L"localhost") == 0);
        if (!isLocal) return NULL;
    }
    HINTERNET s = WinHttpOpen(L"PEC-App-UpdateChecker", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                              WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!s) return NULL;
    HINTERNET c = WinHttpConnect(s, host, uc.nPort, 0);
    if (!c) { WinHttpCloseHandle(s); return NULL; }
    HINTERNET r = WinHttpOpenRequest(c, L"GET", path, NULL, WINHTTP_NO_REFERER,
                                     WINHTTP_DEFAULT_ACCEPT_TYPES, https ? WINHTTP_FLAG_SECURE : 0);
    if (!r ||
        !WinHttpSendRequest(r, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(r, NULL))
    {
        if (r) WinHttpCloseHandle(r);
        WinHttpCloseHandle(c); WinHttpCloseHandle(s);
        return NULL;
    }
    *sOut = s; *cOut = c;
    return r;
}
static void UpdCloseGet(HINTERNET s, HINTERNET c, HINTERNET r)
{
    if (r) WinHttpCloseHandle(r);
    if (c) WinHttpCloseHandle(c);
    if (s) WinHttpCloseHandle(s);
}

// GET a URL into a malloc'd NUL-terminated buffer (caller frees). Follows redirects.
static char* UpdHttpGet(const wchar_t* url, DWORD* outLen)
{
    HINTERNET s, c, r = UpdOpenGet(url, &s, &c);
    if (!r) return NULL;
    char* buf = NULL; DWORD cap = 0, len = 0, avail;
    for (;;)
    {
        if (!WinHttpQueryDataAvailable(r, &avail) || avail == 0) break;
        if (len + avail + 1 > cap)
        {
            DWORD ncap = (len + avail + 1) * 2;
            char* nb = (char*)realloc(buf, ncap);
            if (!nb) { free(buf); buf = NULL; break; }
            buf = nb; cap = ncap;
        }
        DWORD read = 0;
        if (!WinHttpReadData(r, buf + len, avail, &read) || read == 0) break;
        len += read;
    }
    if (buf) buf[len] = 0;
    UpdCloseGet(s, c, r);
    if (buf && outLen) *outLen = len;
    return buf;
}

// Download url -> dest file, posting percent to dlg (if any) via WM_APP_DLPROG.
static BOOL UpdDownload(const wchar_t* url, const wchar_t* dest, HWND dlg)
{
    HINTERNET s, c, r = UpdOpenGet(url, &s, &c);
    if (!r) return FALSE;
    DWORD statusCode = 0, scSz = sizeof(statusCode);
    if (WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &scSz, WINHTTP_NO_HEADER_INDEX))
    {
        if (statusCode != 200)
        {
            PB_WriteAppLog("[UPDATE ERROR] Download failed with HTTP status %lu", statusCode);
            UpdCloseGet(s, c, r);
            return FALSE;
        }
    }
    BOOL ok = FALSE;
    DWORD total = 0, tsz = sizeof(total);
    WinHttpQueryHeaders(r, WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &total, &tsz, WINHTTP_NO_HEADER_INDEX);
    HANDLE f = CreateFileW(dest, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f != INVALID_HANDLE_VALUE)
    {
        BYTE buf[16384]; DWORD got = 0, avail; ok = TRUE;
        for (;;)
        {
            if (!WinHttpQueryDataAvailable(r, &avail)) { ok = FALSE; break; }
            if (avail == 0) break;
            DWORD toread = avail > sizeof(buf) ? sizeof(buf) : avail, read = 0;
            if (!WinHttpReadData(r, buf, toread, &read) || read == 0) { ok = FALSE; break; }
            DWORD written; WriteFile(f, buf, read, &written, NULL);
            got += read;
            if (dlg && total > 0) PostMessageW(dlg, WM_APP_DLPROG, (WPARAM)((got * 100) / total), 0);
        }
        CloseHandle(f);
    }
    UpdCloseGet(s, c, r);
    return ok;
}

// Sanitize the download URL into a safe installer destination under %TEMP%:
// basename only (no traversal), invalid filename chars stripped, reserved device
// names rejected, extension forced to .exe (fallback: PEC-App-Setup.exe).
static BOOL UpdMakeSafeDest(const wchar_t* url, wchar_t* dest, size_t destCch)
{
    if (!url || !dest || destCch == 0) return FALSE;

    const wchar_t* path_end = url;
    while (*path_end && *path_end != L'?' && *path_end != L'#') {
        path_end++;
    }

    const wchar_t* last_slash = NULL;
    for (const wchar_t* p = url; p < path_end; p++) {
        if (*p == L'/' || *p == L'\\') last_slash = p;
    }
    const wchar_t* fn = last_slash ? (last_slash + 1) : url;

    wchar_t clean_fn[MAX_PATH] = {0};
    size_t c_idx = 0;
    for (const wchar_t* p = fn; p < path_end && c_idx < MAX_PATH - 1; p++) {
        if (*p <= 31 || *p == L'/' || *p == L'\\' || *p == L':' || *p == L'*' ||
            *p == L'?' || *p == L'\"' || *p == L'<' || *p == L'>' || *p == L'|') {
            continue;
        }
        clean_fn[c_idx++] = *p;
    }
    clean_fn[c_idx] = L'\0';

    // Trim trailing spaces and dots (invalid in Windows filenames)
    while (c_idx > 0 && (clean_fn[c_idx - 1] == L' ' || clean_fn[c_idx - 1] == L'.')) {
        clean_fn[--c_idx] = L'\0';
    }

    // Verify safe basename: non-empty, no traversal, not reserved device, must end in .exe
    BOOL is_safe = (c_idx >= 4) && (wcsstr(clean_fn, L"..") == NULL);
    if (is_safe) {
        static const wchar_t* reserved[] = {
            L"CON", L"PRN", L"AUX", L"NUL",
            L"COM1", L"COM2", L"COM3", L"COM4", L"COM5", L"COM6", L"COM7", L"COM8", L"COM9",
            L"LPT1", L"LPT2", L"LPT3", L"LPT4", L"LPT5", L"LPT6", L"LPT7", L"LPT8", L"LPT9"
        };
        wchar_t stem[16] = {0};
        size_t s_len = 0;
        while (s_len < 15 && clean_fn[s_len] && clean_fn[s_len] != L'.') {
            stem[s_len] = clean_fn[s_len];
            s_len++;
        }
        stem[s_len] = L'\0';
        for (size_t r = 0; r < sizeof(reserved) / sizeof(reserved[0]); r++) {
            if (_wcsicmp(stem, reserved[r]) == 0) {
                is_safe = FALSE;
                break;
            }
        }
        if (_wcsicmp(&clean_fn[c_idx - 4], L".exe") != 0) {
            is_safe = FALSE;
        }
    }
    if (!is_safe) {
        lstrcpynW(clean_fn, L"PEC-App-Setup.exe", MAX_PATH);
    }

    wchar_t tmp[MAX_PATH];
    DWORD tlen = GetTempPathW(MAX_PATH, tmp);
    if (tlen == 0 || tlen >= MAX_PATH) return FALSE;
    if (tmp[tlen - 1] == L'\\') {
        _snwprintf_s(dest, destCch, _TRUNCATE, L"%s%s", tmp, clean_fn);
    } else {
        _snwprintf_s(dest, destCch, _TRUNCATE, L"%s\\%s", tmp, clean_fn);
    }
    return (dest[0] != 0);
}

typedef enum { UPD_VERIFY_OK = 0, UPD_VERIFY_SHA_FAILED = 1, UPD_VERIFY_AUTH_FAILED = 2 } UpdVerifyResult;

// Shared verify + launch sequence (AUDIT-NAT-1 parity between GUIs): SHA-256 digest
// from the feed is mandatory (missing/mismatched digest aborts, file deleted), then
// Authenticode, and only then the local file is executed. The caller quits the app
// on UPD_VERIFY_OK so the installer can replace files.
static UpdVerifyResult UpdVerifyAndLaunch(const wchar_t* dest, const wchar_t* expectedSha256, HWND owner)
{
    BOOL shaValid = FALSE;
    if (expectedSha256 && wcslen(expectedSha256) == 64)
    {
        shaValid = UpdVerifyFileSha256(dest, expectedSha256);
    }

    if (!shaValid)
    {
        DeleteFileW(dest);
        PB_WriteAppLog("[UPDATE ERROR] SHA-256 verification failed or missing! Aborting update execution.");
        MessageBoxW(owner, L"Ошибка проверки подлинности обновления (SHA-256 отсутствует или не совпадает). Файл удален.", L"Ошибка обновления", MB_ICONERROR);
        return UPD_VERIFY_SHA_FAILED;
    }

    if (!UpdVerifyAuthenticode(dest))
    {
        DeleteFileW(dest);
        PB_WriteAppLog("[UPDATE ERROR] Authenticode signature verification failed! Aborting update execution.");
        MessageBoxW(owner, L"Ошибка проверки цифровой подписи обновления (Authenticode). Файл удален.", L"Ошибка обновления", MB_ICONERROR);
        return UPD_VERIFY_AUTH_FAILED;
    }

    ShellExecuteW(owner, L"open", dest, NULL, NULL, SW_SHOWNORMAL);
    return UPD_VERIFY_OK;
}

#endif // PB_UI_UPDATE_CORE_H
