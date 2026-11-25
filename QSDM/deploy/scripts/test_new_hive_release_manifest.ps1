#Requires -Version 5.1
<#
.SYNOPSIS
  Tests the signed policy fields of new_hive_release_manifest.ps1:
  min_supported_version and rollout_percent.

.DESCRIPTION
  Loads the two functions Assert-HiveReleasePolicy and New-HiveReleaseManifest
  from the signer's own text (PowerShell parser; the signer itself does not
  run) and checks the rules and the signed field order. No key, no signing,
  no network. Runs on Windows PowerShell 5.1 and on pwsh (Linux too).
  Ends with "test_new_hive_release_manifest: N passed, M failed"; exits 1 on a
  failure.
#>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$signer = Join-Path $PSScriptRoot 'new_hive_release_manifest.ps1'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($signer, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "the signer does not parse: $($errors[0].Message)" }
foreach ($name in @('Assert-HiveReleasePolicy', 'New-HiveReleaseManifest')) {
    $definition = $ast.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true)
    if (-not $definition) { throw "the signer has no function $name" }
    . ([ScriptBlock]::Create($definition.Extent.Text))
}

$script:passed = 0
$script:failed = 0
function Check([bool]$Condition, [string]$Name) {
    if ($Condition) { $script:passed++; Write-Host "PASS: $Name" }
    else { $script:failed++; Write-Host "FAIL: $Name" }
}
function Get-Refusal([string]$Version, [string]$Min, [string]$Rollout) {
    try {
        Assert-HiveReleasePolicy -Version $Version -MinSupportedVersion $Min -RolloutPercent $Rollout
        return ''
    }
    catch { return $_.Exception.Message }
}

$artifacts = @(
    [ordered]@{ name = 'latest-linux.yml'; platform = 'linux'; role = 'updater-manifest'; size = 10; sha256 = ('a' * 64) },
    [ordered]@{ name = 'qsdm-hive-1.4.28-linux-x86_64.AppImage'; platform = 'linux'; role = 'installer'; size = 20; sha256 = ('b' * 64) }
)
$issued = [DateTime]::new(2026, 11, 25, 10, 0, 0, [DateTimeKind]::Utc)
function Build([string]$Min, [string]$Rollout) {
    $m = New-HiveReleaseManifest -Platform 'linux' -Version '1.4.28' -MinSupportedVersion $Min -RolloutPercent $Rollout `
        -Commit ('0123456789ABCDEF' * 2 + '01234567') -IssuedAt $issued -ValidDays 90 -KeyId ('C' * 64) -Artifacts $artifacts
    $json = ($m | ConvertTo-Json -Depth 8)
    return [pscustomobject]@{ Keys = (@($m.Keys) -join ','); Json = $json; Parsed = ($json | ConvertFrom-Json) }
}
$baseKeys = 'schema,product,channel,platform,version,commit,issued_at,expires_at,key_id,artifacts'

# ---- the manifest layout
$r = Build '' ''
Check ($r.Keys -ceq $baseKeys) "no policy fields: the fields and order of before ($($r.Keys))"
Check ($r.Json -notmatch 'min_supported_version|rollout_percent') 'no policy fields: neither key is written'
Check ($r.Parsed.commit -ceq ('0123456789abcdef' * 2 + '01234567') -and $r.Parsed.key_id -ceq ('c' * 64)) 'commit and key_id lowercase'
Check ($r.Parsed.issued_at -like '2026-11-25T10:00:00*' -and $r.Parsed.expires_at -like '2027-02-23T10:00:00*') 'issued_at and expires_at (90 days)'
Check (@($r.Parsed.artifacts).Count -eq 2) 'artifacts kept'

$r = Build '1.4.27' ''
Check ($r.Keys -ceq 'schema,product,channel,platform,version,min_supported_version,commit,issued_at,expires_at,key_id,artifacts') 'min: follows version'
Check ($r.Json -match '"min_supported_version":\s+"1\.4\.27"') 'min: a JSON string'

$r = Build '1.4.27' '10'
Check ($r.Keys -ceq 'schema,product,channel,platform,version,min_supported_version,rollout_percent,commit,issued_at,expires_at,key_id,artifacts') 'rollout: follows min_supported_version'
Check ($r.Json -match '"rollout_percent":\s+10,') 'rollout: a JSON number'
Check ($r.Parsed.rollout_percent -eq 10) 'rollout: parses back as 10'

$r = Build '' '100'
Check ($r.Keys -ceq 'schema,product,channel,platform,version,rollout_percent,commit,issued_at,expires_at,key_id,artifacts') 'rollout 100 alone'
$r = Build '1.4.27' '0'
Check ($r.Json -match '"rollout_percent":\s+0,') 'rollout 0 is written (paused), not dropped'

# ---- the rules
$accepted = @(
    @('1.4.28', '', ''),
    @('1.4.28', '1.4.27', ''),
    @('1.4.28', '1.4.28', ''),          # a security release: everyone updates
    @('1.4.28', '1.3.99', ''),
    @('1.4.28', '1.4.27', '0'),
    @('1.4.28', '1.4.27', '1'),
    @('1.4.28', '1.4.27', '50'),
    @('1.4.28', '1.4.27', '100'),
    @('1.4.28', '', '100'),
    @('1.4.28', '1.4.28', '100'),
    @('1.10.0', '1.9.12', '25')         # numeric, not text, comparison
)
foreach ($c in $accepted) {
    $why = Get-Refusal $c[0] $c[1] $c[2]
    Check ($why -eq '') "accepted: version $($c[0]) min '$($c[1])' rollout '$($c[2])' $why"
}
$refused = @(
    @('1.4', '', '', 'Version must use MAJOR.MINOR.PATCH'),
    @('1.4.28', '1.4', '', 'MinSupportedVersion must use MAJOR.MINOR.PATCH'),
    @('1.4.28', '1.4.27-beta', '', 'MinSupportedVersion must use MAJOR.MINOR.PATCH'),
    @('1.4.28', 'v1.4.27', '', 'MinSupportedVersion must use MAJOR.MINOR.PATCH'),
    @('1.4.28', '1.4.29', '', 'must not be above Version'),
    @('1.4.28', '1.5.0', '', 'must not be above Version'),
    @('1.9.12', '1.10.0', '', 'must not be above Version'),
    @('1.4.28', '1.4.27', '101', 'whole number from 0 to 100'),
    @('1.4.28', '1.4.27', '-1', 'whole number from 0 to 100'),
    @('1.4.28', '1.4.27', '05', 'whole number from 0 to 100'),
    @('1.4.28', '1.4.27', '12.5', 'whole number from 0 to 100'),
    @('1.4.28', '1.4.27', 'ten', 'whole number from 0 to 100'),
    @('1.4.28', '1.4.27', ' 10', 'whole number from 0 to 100'),
    @('1.4.28', '', '50', 'needs a MinSupportedVersion below Version'),
    @('1.4.28', '1.4.28', '50', 'needs a MinSupportedVersion below Version'),
    @('1.4.28', '1.4.28', '0', 'needs a MinSupportedVersion below Version')
)
foreach ($c in $refused) {
    $why = Get-Refusal $c[0] $c[1] $c[2]
    Check ($why.Contains($c[3])) "refused: version $($c[0]) min '$($c[1])' rollout '$($c[2])' ($why)"
}

# ---- the signer calls both functions before anything is signed
$text = [IO.File]::ReadAllText($signer)
$assertAt = $text.IndexOf("`nAssert-HiveReleasePolicy -Version `$Version -MinSupportedVersion `$MinSupportedVersion -RolloutPercent `$RolloutPercent")
$buildAt = $text.IndexOf("`n`$manifest = New-HiveReleaseManifest ")
$signAt = $text.IndexOf('wallet sign')
$keyAt = $text.IndexOf('$keystorePath = Join-Path')
Check ($assertAt -gt 0 -and $assertAt -lt $keyAt) 'the policy is checked before the signing inputs are read'
Check ($buildAt -gt 0 -and $buildAt -lt $signAt) 'the signed manifest is built by New-HiveReleaseManifest'
Check (-not $text.Contains("`r")) 'the signer has LF line endings'

Write-Host "test_new_hive_release_manifest: $($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) { exit 1 }
exit 0
