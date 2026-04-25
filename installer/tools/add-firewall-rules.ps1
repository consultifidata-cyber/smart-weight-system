<#
.SYNOPSIS
    Add Windows Firewall inbound rules for Smart Weight System services.

.DESCRIPTION
    Creates named inbound TCP allow rules for all service ports.
    Safe to run multiple times — removes existing rules first.
    Called during install and can be run standalone for repair.
#>
#Requires -RunAsAdministrator

$rules = @(
    @{ Name='SWS-WebUI';       Port=3000;  Desc='Smart Weight System — Web UI'                    },
    @{ Name='SWS-WeightSvc';   Port=5000;  Desc='Smart Weight System — Weight Service'            },
    @{ Name='SWS-PrintSvc';    Port=5001;  Desc='Smart Weight System — Print Service'             },
    @{ Name='SWS-SyncSvc';     Port=5002;  Desc='Smart Weight System — Sync Service'              },
    @{ Name='SWS-Launcher';    Port=5099;  Desc='Smart Weight System — Launcher Health'           },
    @{ Name='SWS-DispatchSvc'; Port=4000;  Desc='Smart Weight System — Dispatch Service (LAN)'   }
)

foreach ($r in $rules) {
    Remove-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    New-NetFirewallRule `
        -DisplayName $r.Name `
        -Direction   Inbound `
        -Protocol    TCP `
        -LocalPort   $r.Port `
        -Action      Allow `
        -Profile     Any `
        -Description $r.Desc | Out-Null
    Write-Host "[FW] $($r.Name) → port $($r.Port)"
}
Write-Host 'Firewall rules configured.'
