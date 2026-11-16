// ui/update.h - update checker (startup + manual): reads a
// custom JSON feed. Notification offers Update Now / Later /
// Don't Ask Again. Unity-build include: pulled into main.c after the theme helpers and the
// globals it uses (g_hInst, g_hMain, g_reallyExit).
// Download/verification primitives live in update_core.h (shared with main_imgui.cpp).
#ifndef PB_UI_UPDATE_H
#define PB_UI_UPDATE_H

#include "../profile/json.h"
#include "update_core.h"

#define UPD_FEED_URL  L"/api/releases"

// AUDIT-NAT-P3 (single version source): pull the release number from the generated
// gui/res/version_gen.h; the 0.0.0 fallback marks builds compiled without it.
#ifndef PEC_APP_VERSION
#if defined(__has_include)
#if __has_include("../res/version_gen.h")
#include "../res/version_gen.h"
#endif
#endif
#ifdef APP_VERSION
#define PEC_APP_VERSION APP_VERSION
#else
#define PEC_APP_VERSION L"0.0.0"
#endif
#endif

#define WM_APP_UPDATE  (WM_APP + 6)   // check worker -> main window (result)
#define WM_APP_DLDONE  (WM_APP + 8)   // download worker -> dialog (success + job)

// Parse the first three dot-separated integers, ignoring a leading 'v' and any suffix ("-Beta").
static void UpdParseVer(const wchar_t* s, int out[3])
{
    out[0] = out[1] = out[2] = 0;
    int i = 0;
    while (*s && (*s < L'0' || *s > L'9')) s++;   // skip 'v' / leading junk
    while (*s && i < 3)
    {
        if (*s >= L'0' && *s <= L'9') { int n = 0; while (*s >= L'0' && *s <= L'9') { n = n * 10 + (*s - L'0'); s++; } out[i++] = n; }
        else if (*s == L'.') s++;
        else break;                                // stop at '-Beta' etc.
    }
}
static int UpdVerCmp(const int a[3], const int b[3])
{
    for (int i = 0; i < 3; i++) if (a[i] != b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

// Fetch + parse the feed. Fills *out; returns FALSE only on network/parse failure.
static BOOL UpdCheck(UpdInfo* out)
{
    ZeroMemory(out, sizeof(*out));
    DWORD len = 0;
    wchar_t feedUrl[1024];
    if (g_profile.pecSync.serverUrl[0]) {
        _snwprintf_s(feedUrl, 1024, _TRUNCATE, L"%s/api/releases", g_profile.pecSync.serverUrl);
    } else {
        lstrcpynW(feedUrl, L"https://api.github.com/repos/vlv-code/PEC/releases/latest", 1024);
    }
    char* body = UpdHttpGet(feedUrl, &len);
    if (!body) return FALSE;
    JVal* root = json_parse(body, len);
    free(body);
    if (!root) return FALSE;
    BOOL ok = FALSE;
    JVal* win = json_get(root, "windows");
    if (win)
    {
        const char* ver   = json_str(win, "version", NULL);
        const char* dl    = json_str(win, "download", NULL);
        const char* notes = json_str(win, "release_notes", NULL);
        const char* date  = json_str(win, "release_date", NULL);
        const char* sha   = json_str(win, "sha256", NULL);
        if (ver)   U8W(ver,   out->latest,   32);
        if (dl)    U8W(dl,     out->download, 512);
        if (notes) U8W(notes,  out->notes,    512);
        if (date)  U8W(date,   out->date,     32);
        if (sha)   U8W(sha,    out->sha256,   65);
        int cur[3], lat[3];
        UpdParseVer(PEC_APP_VERSION, cur);
        UpdParseVer(out->latest, lat);
        if (UpdVerCmp(lat, cur) <= 0)
        {
            PB_WriteAppLog("Update offer ignored: version not newer (latest: %ls, current: %ls)", out->latest, PEC_APP_VERSION);
            out->available = FALSE;
        }
        else
        {
            out->available = (out->download[0] != 0);
        }
        ok = TRUE;
    }
    json_free(root);
    return ok;
}

// notification dialog
typedef struct { HWND dlg; wchar_t url[512]; wchar_t dest[MAX_PATH]; } UpdDl;
static DWORD WINAPI UpdDlThread(LPVOID p)
{
    UpdDl* d = (UpdDl*)p;
    BOOL ok = UpdDownload(d->url, d->dest, d->dlg);
    PostMessageW(d->dlg, WM_APP_DLDONE, (WPARAM)(ok ? 1 : 0), (LPARAM)d);   // handler frees d
    return 0;
}
INT_PTR CALLBACK UpdateDlgProc(HWND dlg, UINT msg, WPARAM wp, LPARAM lp)
{
    switch (msg)
    {
    case WM_INITDIALOG:
    {
        SetWindowLongPtrW(dlg, GWLP_USERDATA, (LONG_PTR)lp);
        UpdInfo* info = (UpdInfo*)lp;
        SetWindowTextW(dlg, T(S_UPD_TITLE));
        SetDlgItemTextW(dlg, IDC_UP_TEXT, T(S_UPD_AVAIL));
        wchar_t v[160]; _snwprintf_s(v, 160, _TRUNCATE, L"%s  \x2192  %s", APP_VERSION, info->latest);
        SetDlgItemTextW(dlg, IDC_UP_VERS, v);
        if (info->date[0]) { wchar_t d[64]; _snwprintf_s(d, 64, _TRUNCATE, L"(%s)", info->date); SetDlgItemTextW(dlg, IDC_UP_DATE, d); }
        if (info->notes[0]) { wchar_t n[640]; _snwprintf_s(n, 640, _TRUNCATE, L"<a href=\"%s\">%s</a>", info->notes, T(S_UPD_NOTES)); SetDlgItemTextW(dlg, IDC_UP_NOTES, n); }
        else ShowWindow(GetDlgItem(dlg, IDC_UP_NOTES), SW_HIDE);
        SetDlgItemTextW(dlg, IDC_UP_NOW,     T(S_UPD_NOW));
        SetDlgItemTextW(dlg, IDCANCEL,       T(S_UPD_LATER));
        SetDlgItemTextW(dlg, IDC_UP_DONTASK, T(S_UPD_DONTASK));
        ShowWindow(GetDlgItem(dlg, IDC_UP_PROGRESS), SW_HIDE);
        InitDarkMode(dlg);
        return TRUE;
    }
    PB_DARK_CTLCOLORS;
    case WM_NOTIFY:
    {
        LPNMHDR nh = (LPNMHDR)lp;
        if ((nh->code == NM_CLICK || nh->code == NM_RETURN) && nh->idFrom == IDC_UP_NOTES)
        { PNMLINK link = (PNMLINK)lp; ShellExecuteW(dlg, L"open", link->item.szUrl, NULL, NULL, SW_SHOWNORMAL); }
        return TRUE;
    }
    case WM_APP_DLPROG:
        SendDlgItemMessageW(dlg, IDC_UP_PROGRESS, PBM_SETPOS, (WPARAM)wp, 0);
        return TRUE;
    case WM_APP_DLDONE:
    {
        UpdDl* d = (UpdDl*)lp;
        if (!d) return TRUE;
        {   // job finished: drop the WM_NCDESTROY tracking props
            HANDLE th = (HANDLE)RemovePropW(dlg, L"PEC_UpdThr");
            if (th) CloseHandle(th);
            RemovePropW(dlg, L"PEC_UpdJob");
        }
        if (wp)   // success: launch the installer and quit so it can replace files
        {
            UpdInfo* info = (UpdInfo*)GetWindowLongPtrW(dlg, GWLP_USERDATA);
            UpdVerifyResult vr = UpdVerifyAndLaunch(d->dest, info ? info->sha256 : NULL, dlg);
            if (vr == UPD_VERIFY_OK)
            {
                free(d);
                g_reallyExit = TRUE;
                DestroyWindow(g_hMain);
                return TRUE;
            }
            SetDlgItemTextW(dlg, IDC_UP_STATUS,
                vr == UPD_VERIFY_SHA_FAILED ? L"Ошибка проверки целостности (SHA-256)"
                                            : L"Ошибка проверки цифровой подписи");
            EnableWindow(GetDlgItem(dlg, IDC_UP_NOW), TRUE);
            free(d);
            return TRUE;
        }
        SetDlgItemTextW(dlg, IDC_UP_STATUS, T(S_UPD_DLFAIL));
        EnableWindow(GetDlgItem(dlg, IDC_UP_NOW), TRUE);
        free(d);
        return TRUE;
    }
    case WM_NCDESTROY:
    {
        // AUDIT-NAT-P3: the dialog can be destroyed mid-download — cancel the worker's
        // blocking I/O, join it briefly, then free the pending job. If the worker misses
        // the join window it still owns the pointer, so leak it instead of freeing.
        HANDLE th = (HANDLE)GetPropW(dlg, L"PEC_UpdThr");
        UpdDl* pend = (UpdDl*)GetPropW(dlg, L"PEC_UpdJob");
        if (th)
        {
            CancelSynchronousIo(th);
            if (WaitForSingleObject(th, 2000) == WAIT_OBJECT_0 && pend) free(pend);
            CloseHandle(th);
        }
        RemovePropW(dlg, L"PEC_UpdThr");
        RemovePropW(dlg, L"PEC_UpdJob");
        return FALSE;
    }
    case WM_COMMAND:
        switch (LOWORD(wp))
        {
        case IDC_UP_NOW:
        {
            UpdInfo* info = (UpdInfo*)GetWindowLongPtrW(dlg, GWLP_USERDATA);
            if (!UpdIsHttpUrl(info->download))
            {
                PB_WriteAppLog("[UPDATE ERROR] Rejected non-http(s) update URL: %ls", info->download);
                MessageBoxW(dlg, L"Отклонён небезопасный URL обновления (разрешены только http/https).", L"Ошибка обновления", MB_ICONERROR);
                return TRUE;
            }
            UpdDl* d = (UpdDl*)calloc(1, sizeof(UpdDl));
            if (!d) return TRUE;
            d->dlg = dlg; lstrcpynW(d->url, info->download, 512);

            // Sanitize download filename (basename only, forced .exe) under %TEMP%
            if (!UpdMakeSafeDest(d->url, d->dest, MAX_PATH)) { free(d); return TRUE; }

            EnableWindow(GetDlgItem(dlg, IDC_UP_NOW), FALSE);
            ShowWindow(GetDlgItem(dlg, IDC_UP_PROGRESS), SW_SHOW);
            SendDlgItemMessageW(dlg, IDC_UP_PROGRESS, PBM_SETRANGE, 0, MAKELPARAM(0, 100));
            SetDlgItemTextW(dlg, IDC_UP_STATUS, T(S_UPD_DLING));
            HANDLE t = CreateThread(NULL, 0, UpdDlThread, d, 0, NULL);
            if (t)
            {
                // AUDIT-NAT-P3: track the in-flight job so WM_NCDESTROY can clean it up
                SetPropW(dlg, L"PEC_UpdJob", (HANDLE)d);
                SetPropW(dlg, L"PEC_UpdThr", t);
            }
            else { free(d); EnableWindow(GetDlgItem(dlg, IDC_UP_NOW), TRUE); }
            return TRUE;
        }
        case IDC_UP_DONTASK: PB_SetCheckUpdates(FALSE); EndDialog(dlg, 0); return TRUE;
        case IDCANCEL:       EndDialog(dlg, 0); return TRUE;
        }
        return FALSE;
    }
    return FALSE;
}

// orchestration
typedef struct { HWND owner; BOOL manual; } UpdJob;
static DWORD WINAPI UpdCheckThread(LPVOID p)
{
    UpdJob* j = (UpdJob*)p;
    UpdInfo* info = (UpdInfo*)malloc(sizeof(UpdInfo));
    BOOL ok = FALSE;
    if (info) { ok = UpdCheck(info); if (!ok) ZeroMemory(info, sizeof(*info)); }
    WPARAM flags = (ok ? 1u : 0u) | (j->manual ? 2u : 0u);
    PostMessageW(j->owner, WM_APP_UPDATE, flags, (LPARAM)info);
    free(j);
    return 0;
}
// Kick off a check on a worker thread. manual=TRUE also reports "up to date" / errors.
static void UpdStartCheck(HWND owner, BOOL manual)
{
    UpdJob* j = (UpdJob*)calloc(1, sizeof(UpdJob));
    if (!j) return;
    j->owner = owner; j->manual = manual;
    HANDLE t = CreateThread(NULL, 0, UpdCheckThread, j, 0, NULL);
    if (t) CloseHandle(t); else free(j);
}

#endif // PB_UI_UPDATE_H
