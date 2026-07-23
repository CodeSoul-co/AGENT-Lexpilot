$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$secureKey = Read-Host '请输入 DeepSeek API Key（输入不会回显）' -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
  $env:LEGAL_AGENT_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  $env:LEGAL_AGENT_PROVIDER = 'deepseek'
  $env:LEGAL_AGENT_BASE_URL = 'https://api.deepseek.com/v1'
  $env:LEGAL_AGENT_MODEL = 'deepseek-v4-pro'
  $env:LEGAL_AGENT_FALLBACK = 'demo'
  $env:LEGAL_AGENT_TIMEOUT_MS = '8000'

  if ([string]::IsNullOrWhiteSpace($env:LEGAL_SESSION_KEY_BASE64)) {
    $env:LEGAL_SESSION_KEY_BASE64 = & node "$PSScriptRoot/generate-session-key.cjs"
  }
  if ([string]::IsNullOrWhiteSpace($env:LEGAL_SESSION_OWNER_ID)) {
    $env:LEGAL_SESSION_OWNER_ID = 'local-demo-user'
  }
  if ([string]::IsNullOrWhiteSpace($env:LEGAL_SESSION_DATA_DIR)) {
    $env:LEGAL_SESSION_DATA_DIR = 'data/web-demo'
  }

  & node "$PSScriptRoot/demo-web.cjs"
  if ($LASTEXITCODE -ne 0) {
    throw "DeepSeek 网页 Demo 退出码：$LASTEXITCODE"
  }
} finally {
  Remove-Item Env:LEGAL_AGENT_API_KEY -ErrorAction SilentlyContinue
  if ($keyPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  }
}
