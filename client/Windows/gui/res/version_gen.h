#ifndef VERSION_GEN_H
#define VERSION_GEN_H

#define PB_VER_MAJOR 2
#define PB_VER_MINOR 3
#define PB_VER_PATCH 0
#define PB_VER_BUILD 0
#define PB_VER_STR "2.3.0"
#define PB_VER_STRW L"2.3.0"

#define APP_VER_MAJOR 2
#define APP_VER_MINOR 3
#define APP_VER_PATCH 0
#define APP_VER_BUILD 0
#define APP_VERSION_STR "2.3.0.0"
#define APP_VERSION_STRW L"2.3.0.0"
#define APP_VERSION_W L"2.3.0"
#define APP_VERSION_NARROW "2.3.0"
#define VERSION "2.3.0"
#define VERSION_W L"2.3.0"

#ifndef APP_VERSION
#define APP_VERSION L"2.3.0"
#endif

#ifndef PEC_APP_VERSION
#define PEC_APP_VERSION L"2.3.0"
#endif

#ifndef PEC_DEFAULT_SERVER_URL
#define PEC_DEFAULT_SERVER_URL "https://update.example.com"
#define PEC_DEFAULT_SERVER_URL_W L"https://update.example.com"
#endif

#ifndef PEC_DEFAULT_FLEET_TOKEN
#define PEC_DEFAULT_FLEET_TOKEN ""
#define PEC_DEFAULT_FLEET_TOKEN_W L""
#endif

#endif // VERSION_GEN_H
