<#
.SYNOPSIS
    DeepSeek Harness (DSH) 任务分发与验收插件一键安装脚本
.DESCRIPTION
    将当前目录的 dsh-task-dispatcher 以 link 形式注册到 DSH Desktop Profile 中，并写入 cordis.patch 配置。
.PARAMETER Uninstall
    如果指定该开关，则从 Profile 中卸载并恢复配置。
#>

param(
    [switch]$Uninstall,
    [string]$ProfileDir = "$env:USERPROFILE\.dsh\profiles\desktop"
)

$ErrorActionPreference = "Stop"
$PluginName = "dsh-task-dispatcher"
$PluginPath = (Get-Item $PSScriptRoot).FullName -replace '\\', '/'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   DeepSeek Harness 智能任务分发与验收插件安装器" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

if (-not (Test-Path $ProfileDir)) {
    Write-Host "[错误] 未找到 DSH Profile 目录: $ProfileDir" -ForegroundColor Red
    Write-Host "请确认 DeepSeek Harness 是否已初始化安装。" -ForegroundColor Yellow
    exit 1
}

$PackageJsonPath = Join-Path $ProfileDir "package.json"
$CordisPatchPath = Join-Path $ProfileDir "cordis.patch.yml"

if (-not (Test-Path $PackageJsonPath)) {
    Write-Host "[错误] 未找到 Profile 的 package.json: $PackageJsonPath" -ForegroundColor Red
    exit 1
}

function Backup-File($filePath) {
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupPath = "$filePath.bak-$PluginName-$timestamp"
    Copy-Item $filePath $backupPath -Force
    Write-Host "[备份] 已创建备份: $(Split-Path $backupPath -Leaf)" -ForegroundColor Gray
}

if ($Uninstall) {
    Write-Host "[操作] 正在从 DSH 中卸载 $PluginName ..." -ForegroundColor Yellow

    Backup-File $PackageJsonPath
    $pkg = Get-Content $PackageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($pkg.dependencies.PSObject.Properties[$PluginName]) {
        $pkg.dependencies.PSObject.Properties.Remove($PluginName)
    }
    if ($pkg.dsh.profile.bundles) {
        $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $PluginName })
    }
    $pkg | ConvertTo-Json -Depth 10 | Set-Content $PackageJsonPath -Encoding UTF8
    Write-Host "[完成] package.json 已清理依赖与 Bundle 注册。" -ForegroundColor Green

    if (Test-Path $CordisPatchPath) {
        Backup-File $CordisPatchPath
        $patchLines = Get-Content $CordisPatchPath -Encoding UTF8
        $filtered = @()
        $skip = $false
        foreach ($line in $patchLines) {
            if ($line -match "id:\s*$PluginName") {
                $skip = $true
                continue
            }
            if ($skip -and $line -match "^-\s+id:") {
                $skip = $false
            }
            if (-not $skip) {
                $filtered += $line
            }
        }
        $filtered | Set-Content $CordisPatchPath -Encoding UTF8
        Write-Host "[完成] cordis.patch.yml 已移除配置项。" -ForegroundColor Green
    }

    Write-Host "[成功] $PluginName 卸载完成！重启 DeepSeek Harness 即可。" -ForegroundColor Cyan
    exit 0
}

Write-Host "[1/2] 正在注册插件到 package.json ..." -ForegroundColor Green
Backup-File $PackageJsonPath

$pkg = Get-Content $PackageJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json

if (-not $pkg.dependencies) {
    $pkg | Add-Member -MemberType NoteProperty -Name "dependencies" -Value (New-Object PSObject)
}
if (-not $pkg.dependencies.PSObject.Properties[$PluginName]) {
    $pkg.dependencies | Add-Member -MemberType NoteProperty -Name $PluginName -Value "link:$PluginPath"
} else {
    $pkg.dependencies.$PluginName = "link:$PluginPath"
}

if (-not $pkg.dsh.profile.bundles) {
    $pkg.dsh.profile | Add-Member -MemberType NoteProperty -Name "bundles" -Value @()
}
if ($pkg.dsh.profile.bundles -notcontains $PluginName) {
    $pkg.dsh.profile.bundles += $PluginName
}

$pkg | ConvertTo-Json -Depth 10 | Set-Content $PackageJsonPath -Encoding UTF8
Write-Host "  -> 依赖与 Bundle 列表已更新 (link:$PluginPath)" -ForegroundColor Green

Write-Host "[2/2] 正在配置 cordis.patch.yml ..." -ForegroundColor Green
if (Test-Path $CordisPatchPath) {
    $patchContent = Get-Content $CordisPatchPath -Raw -Encoding UTF8
    if ($patchContent -notmatch "id:\s*$PluginName") {
        Backup-File $CordisPatchPath
        $patchSnippet = @"

- id: $PluginName
  name: $PluginName
  config:
    toolName: dispatch_task
    defaultReasoningEffort: low
    maxRounds: 3
    autoVerifyFiles: true
"@
        Add-Content -Path $CordisPatchPath -Value $patchSnippet -Encoding UTF8
        Write-Host "  -> 已向 cordis.patch.yml 追加插件配置。" -ForegroundColor Green
    } else {
        Write-Host "  -> cordis.patch.yml 已存在 $PluginName 配置，跳过追加。" -ForegroundColor Gray
    }
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   🎉 安装成功！" -ForegroundColor Cyan
Write-Host "   请重启正在运行的 DeepSeek Harness 客户端。" -ForegroundColor Green
Write-Host "   生效后主 Agent 将具备 'dispatch_task' 任务分发与验收能力！" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
