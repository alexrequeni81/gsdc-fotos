# setup-netlify.ps1
# Prepara el entorno de Netlify en Windows para el proyecto GSDC Fotos.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-netlify.ps1
#
# Parametros opcionales:
#   -SkipInstall   No instala nada; solo verifica y muestra instrucciones.
#   -SiteId <id>   SITE_ID de Netlify (si ya lo tienes).
#
# Seguridad:
#   - No almacena tokens. La autenticacion se hace con "netlify login" (navegador).
#   - Pide confirmacion antes de instalar paquetes.
#   - No hace deploy automatico; solo prepara el entorno.

param(
    [switch]$SkipInstall,
    [string]$SiteId = ""
)

$ErrorActionPreference = "Stop"

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Yellow }
function Write-Ok($msg)   { Write-Host $msg -ForegroundColor Green }
function Write-Warn($msg) { Write-Host $msg -ForegroundColor DarkYellow }
function Write-Err($msg)  { Write-Host $msg -ForegroundColor Red }

Write-Host "=== GSDC Fotos - Setup Netlify ===" -ForegroundColor Cyan

# 1. Node.js / npm
Write-Step "[1/5] Verificando Node.js y npm..."
if (Test-Command node) {
    $nodeVer = node --version
    Write-Ok "Node.js encontrado: $nodeVer"
} else {
    Write-Err "Node.js NO esta instalado."
    if ($SkipInstall) {
        Write-Warn "Instala Node.js desde https://nodejs.org (LTS) y vuelve a ejecutar este script."
        exit 1
    }
    # Intentar con winget
    if (Test-Command winget) {
        $ans = Read-Host "Instalar Node.js LTS con winget? (s/n)"
        if ($ans -eq "s") {
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            if ($LASTEXITCODE -ne 0) { throw "Fallo la instalacion de Node.js." }
            Write-Ok "Node.js instalado. Cierra y reabre PowerShell, luego vuelve a ejecutar este script."
            exit 0
        } else {
            Write-Warn "Instala Node.js manualmente desde https://nodejs.org y vuelve a ejecutar."
            exit 1
        }
    } else {
        Write-Warn "winget no disponible. Instala Node.js manualmente desde https://nodejs.org"
        exit 1
    }
}

if (Test-Command npm) {
    $npmVer = npm --version
    Write-Ok "npm encontrado: $npmVer"
} else {
    Write-Err "npm no esta disponible aunque Node.js si. Reinstala Node.js."
    exit 1
}

# 2. Netlify CLI
Write-Step "[2/5] Verificando Netlify CLI..."
if (Test-Command netlify) {
    $netVer = netlify --version
    Write-Ok "Netlify CLI encontrado: $netVer"
} else {
    Write-Warn "Netlify CLI NO esta instalado."
    if ($SkipInstall) {
        Write-Warn "Instala con: npm install -g netlify-cli"
        exit 1
    }
    $ans = Read-Host "Instalar Netlify CLI globalmente con npm? (s/n)"
    if ($ans -eq "s") {
        npm install -g netlify-cli
        if ($LASTEXITCODE -ne 0) { throw "Fallo la instalacion de Netlify CLI." }
        Write-Ok "Netlify CLI instalado."
    } else {
        Write-Warn "Instala manualmente con: npm install -g netlify-cli"
        exit 1
    }
}

# 3. Autenticacion en Netlify
Write-Step "[3/5] Autenticacion en Netlify..."
netlify status 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "No hay sesion activa en Netlify."
    $ans = Read-Host "Ejecutar 'netlify login' ahora? (s/n)"
    if ($ans -eq "s") {
        netlify login
        if ($LASTEXITCODE -ne 0) { throw "Fallo netlify login." }
        Write-Ok "Autenticado en Netlify."
    } else {
        Write-Warn "Ejecuta 'netlify login' manualmente antes de desplegar."
    }
} else {
    Write-Ok "Sesion de Netlify activa."
    netlify status
}

# 4. Configuracion del sitio
Write-Step "[4/5] Configuracion del sitio..."
$stateFile = ".netlify\state.json"
if (Test-Path $stateFile) {
    Write-Ok "Archivo de estado encontrado: $stateFile"
    Get-Content $stateFile
} else {
    Write-Warn "No se encontro .netlify\state.json (sitio no vinculado)."
    if ($SiteId) {
        Write-Ok "SITE_ID proporcionado: $SiteId"
        Write-Warn "Vincula el sitio con: netlify link --id $SiteId"
    } else {
        Write-Warn "Para vincular el sitio, ejecuta uno de:"
        Write-Host "  netlify link                    # selecciona sitio interactivo" -ForegroundColor DarkGray
        Write-Host "  netlify link --id <SITE_ID>     # vincula por ID" -ForegroundColor DarkGray
        Write-Host "  netlify init                    # crea nuevo sitio" -ForegroundColor DarkGray
    }
}

# 5. Resumen y flujo de trabajo
Write-Step "[5/5] Flujo de trabajo recomendado"
Write-Host ""
Write-Host "  Desarrollo local (con funciones):" -ForegroundColor White
Write-Host "    netlify dev" -ForegroundColor DarkGray
Write-Host "    -> Abre http://localhost:8888 con funciones emuladas" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Deploy de prueba (draft, no produccion):" -ForegroundColor White
Write-Host "    netlify deploy --dir public" -ForegroundColor DarkGray
Write-Host "    -> Genera URL temporal para probar" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Deploy a produccion:" -ForegroundColor White
Write-Host "    netlify deploy --prod --dir public" -ForegroundColor DarkGray
Write-Host "    -> Publica en la URL de produccion" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Verificar estado:" -ForegroundColor White
Write-Host "    netlify status" -ForegroundColor DarkGray
Write-Host "    netlify functions:list" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Variables de entorno (configurar en panel de Netlify):" -ForegroundColor White
Write-Host "    TENANT_ID, CLIENT_ID, CLIENT_SECRET, SITE_HOST, SITE_PATH, BASE_FOLDER" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Seguridad:" -ForegroundColor White
Write-Host "    - Nunca commitees .env ni secretos." -ForegroundColor DarkGray
Write-Host "    - Rota CLIENT_SECRET tras la activacion del consentimiento." -ForegroundColor DarkGray
Write-Host "    - Usa 'netlify env:set' para variables locales de prueba." -ForegroundColor DarkGray
Write-Host ""
Write-Ok "=== Setup Netlify completado ==="
