param(
    [string]$ProxyAddress = ''
)

$ErrorActionPreference = 'Stop'

if ($ProxyAddress -and $ProxyAddress.Trim()) {
    $proxy = $ProxyAddress.Trim()
    $env:HTTP_PROXY = $proxy
    $env:HTTPS_PROXY = $proxy
    Write-Host "[安装] 使用代理: $proxy"
} else {
    Write-Host '[安装] 未设置代理，直连下载'
}

Write-Host '[安装] 正在执行: irm https://claude.ai/install.ps1 | iex'
Write-Host ''

Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression

Write-Host ''
Write-Host '[安装] Claude Code CLI 安装脚本执行完毕。'
