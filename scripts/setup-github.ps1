# setup-github.ps1
# Configura Git + GitHub para el proyecto "Fotos Envios GSDC".
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-github.ps1
#
# Parametros opcionales:
#   -SkipAuth   No ejecuta gh auth login (si ya estas autenticado).
#   -Push       Hace push a origin/main sin preguntar (por defecto pregunta).
#
# Seguridad:
#   - No almacena ni imprime tokens. La autenticacion se hace con "gh auth login"
#     (flujo interactivo en navegador).
#   - Pide confirmacion antes de crear el commit y antes del push.
#   - Crea un .gitignore que excluye .env, claves y artefactos de build.

param(
    [switch]$SkipAuth,
    [switch]$Push
)

$ErrorActionPreference = "Stop"

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "=== GSDC Fotos - Setup GitHub ===" -ForegroundColor Cyan

# 1. Prerequisitos
if (-not (Test-Command git)) { throw "git no esta instalado o no esta en PATH." }
if (-not (Test-Command gh))  { throw "gh (GitHub CLI) no esta instalado o no esta en PATH." }

# 2. Autenticacion en GitHub
if (-not $SkipAuth) {
    Write-Host "`n[1/6] Autenticacion en GitHub..." -ForegroundColor Yellow
    gh auth status 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "No hay sesion activa. Se abrira el flujo de login de GitHub (navegador)." -ForegroundColor Yellow
        gh auth login
        if ($LASTEXITCODE -ne 0) { throw "Fallo gh auth login." }
    } else {
        Write-Host "Sesion de GitHub ya activa." -ForegroundColor Green
    }
}

# 3. Identidad de commit
Write-Host "`n[2/6] Identidad de commit..." -ForegroundColor Yellow
$name  = git config --global user.name
$email = git config --global user.email
if (-not $name) {
    $name = Read-Host "Nombre para los commits (ej. Alex Requeni)"
    git config --global user.name $name
}
if (-not $email) {
    $email = Read-Host "Email para los commits"
    git config --global user.email $email
}
Write-Host "Commit como: $name <$email>" -ForegroundColor Green

# 4. Inicializar repositorio
Write-Host "`n[3/6] Inicializando repositorio..." -ForegroundColor Yellow
if (-not (Test-Path ".git")) {
    git init
    if ($LASTEXITCODE -ne 0) { throw "Fallo git init." }
} else {
    Write-Host "Ya existe .git, se reutiliza." -ForegroundColor Green
}

# 5. .gitignore
Write-Host "`n[4/6] .gitignore..." -ForegroundColor Yellow
$gitignorePath = ".gitignore"
if (-not (Test-Path $gitignorePath)) {
    $content = @"
# Dependencias
node_modules/
vendor/

# Entornos y secretos
.env
.env.*
*.pem
*.key
*.p12
*.pfx

# Netlify
.netlify/

# Build / salida
dist/
build/
out/

# Sistema
.DS_Store
Thumbs.db
desktop.ini

# Logs
*.log
npm-debug.log*
"@
    Set-Content -Path $gitignorePath -Value $content -Encoding UTF8
    Write-Host ".gitignore creado." -ForegroundColor Green
} else {
    Write-Host ".gitignore ya existe, no se modifica." -ForegroundColor Green
}

# 6. Remote origin
Write-Host "`n[5/6] Configurando remote origin..." -ForegroundColor Yellow
$remoteUrl = "https://github.com/alexrequeni81/gsdc-fotos.git"
$existing = $null
try { $existing = git remote get-url origin 2>$null } catch { $existing = $null }
if (-not $existing) {
    git remote add origin $remoteUrl
} elseif ($existing -ne $remoteUrl) {
    Write-Host "Remote origin existente: $existing" -ForegroundColor Yellow
    $change = Read-Host "Reemplazar por $remoteUrl? (s/n)"
    if ($change -eq "s") { git remote set-url origin $remoteUrl }
}
Write-Host "Remote: $(git remote get-url origin)" -ForegroundColor Green

# 7. Commit inicial
Write-Host "`n[6/6] Commit inicial..." -ForegroundColor Yellow
git add -A
Write-Host "--- Archivos a commitear ---" -ForegroundColor DarkGray
git status --short
$confirm = Read-Host "Crear commit inicial con los archivos listados? (s/n)"
if ($confirm -eq "s") {
    git commit -m "chore: initial commit"
    if ($LASTEXITCODE -ne 0) { throw "Fallo git commit." }
    git branch -M main
    Write-Host "Commit creado en rama main." -ForegroundColor Green
} else {
    Write-Host "Commit cancelado por el usuario." -ForegroundColor Yellow
    exit 0
}

# 8. Push (opcional)
if ($Push) {
    $doPush = "s"
} else {
    $doPush = Read-Host "Hacer push a origin/main ahora? (s/n)"
}
if ($doPush -eq "s") {
    git push -u origin main
    if ($LASTEXITCODE -ne 0) { throw "Fallo git push." }
    Write-Host "Push completado." -ForegroundColor Green
} else {
    Write-Host "Push omitido. Ejecuta 'git push -u origin main' cuando quieras." -ForegroundColor Yellow
}

Write-Host "`n=== Listo ===" -ForegroundColor Cyan