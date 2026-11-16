# Checks the signed Windows installer as Windows checks it (docs/windows.md,
# "Signing"): each file's Authenticode signature must be valid, which means
# its hash matches and its chain reaches a root Windows trusts, name the
# expected publisher, and carry a timestamp, so it stays valid after the
# short-lived signing certificate expires. With -Altered, a copy of that
# file with one byte changed must fail as altered.
#
# Runs in Windows PowerShell 5.1, the one Windows ships, and in PowerShell 7.
param(
  [Parameter(Mandatory = $true)][string]$Publisher,
  [Parameter(Mandatory = $true)][string[]]$Path,
  [string]$Altered
)
$ErrorActionPreference = 'Stop'

foreach ($file in $Path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  $signer = $signature.SignerCertificate
  $name = if ($signer) { $signer.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { '' }
  $stamp = $signature.TimeStamperCertificate
  Write-Output "$file"
  Write-Output "  status: $($signature.Status) ($($signature.StatusMessage))"
  Write-Output "  publisher: $name"
  if ($signer) {
    Write-Output "  subject: $($signer.Subject)"
    Write-Output "  issuer: $($signer.Issuer)"
    Write-Output "  certificate valid: $($signer.NotBefore.ToString('u')) to $($signer.NotAfter.ToString('u'))"
  }
  if ($stamp) { Write-Output "  timestamped by: $($stamp.Subject)" }
  if ($signature.Status -ne 'Valid') { throw "$file is not validly signed: $($signature.Status), $($signature.StatusMessage)" }
  if ($name -ne $Publisher) { throw "$file names publisher '$name', not '$Publisher'" }
  if (-not $stamp) { throw "$file carries no timestamp, so its signature ends when its certificate does" }
}

if ($Altered) {
  $copy = Join-Path ([System.IO.Path]::GetTempPath()) ("altered-" + [System.IO.Path]::GetFileName($Altered))
  Copy-Item -LiteralPath $Altered -Destination $copy -Force
  try {
    $bytes = [System.IO.File]::ReadAllBytes($copy)
    # The middle of the file is the signed content, never the signature
    # itself, which sits at its end.
    $middle = [int]($bytes.Length / 2)
    $bytes[$middle] = $bytes[$middle] -bxor 0xFF
    [System.IO.File]::WriteAllBytes($copy, $bytes)
    $signature = Get-AuthenticodeSignature -LiteralPath $copy
    Write-Output "$Altered with byte $middle changed"
    Write-Output "  status: $($signature.Status) ($($signature.StatusMessage))"
    if ($signature.Status -ne 'HashMismatch') { throw "an altered copy of $Altered reads $($signature.Status), not HashMismatch" }
  } finally {
    Remove-Item -LiteralPath $copy -Force -ErrorAction SilentlyContinue
  }
}
