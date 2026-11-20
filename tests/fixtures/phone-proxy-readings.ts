// INF-1936: original readings from run 41208563961, artifact 13048510832.
// No proxy process table was captured; tests explicitly model that missing boundary.
export const phoneProxyReadings = [
  {
    device: "iphone",
    owner: {
      simulator: "529E76C9-BF19-474D-A109-48554170D7C3",
      manager: {
        pid: 5842,
        parent: 5829,
        started: "Sat Oct 31 15:18:11 2026",
        executable:
          "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24.1.434.0.Mx7b2A/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/runningboardd",
      },
      launcher: {
        pid: 5829,
        parent: 1,
        started: "Sat Oct 31 15:18:11 2026",
        executable: "launchd_sim",
      },
    },
    table:
      " 5829     1 Sat Oct 31 15:18:11 2026     launchd_sim\n 5842  5829 Sat Oct 31 15:18:11 2026     /private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24.1.434.0.Mx7b2A/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/runningboardd\n 7037  5829 Sat Oct 31 15:22:01 2026     /Users/admin/Library/Developer/CoreSimulator/Devices/529E76C9-BF19-474D-A109-48554170D7C3/data/Containers/Bundle/Application/DE025FB6-B360-4AAA-AF63-7FA032A8E1FF/Infinitary.app/Infinitary\n",
    spawned:
      "2026-10-31 15:27:25.217155 (pid/7037/com.apple.WebKit.WebContent.06692B99-DFE3-4417-83AD-BF8622C91C63 [7484]) <Notice>: xpcproxy_sim spawned with pid 7484",
    running:
      "2026-10-31 15:28:49.500131 (pid/7037/com.apple.WebKit.WebContent.06692B99-DFE3-4417-83AD-BF8622C91C63 [7484]) <Notice>: service state: running",
  },
  {
    device: "ipad",
    owner: {
      simulator: "80FC137B-DA21-44F6-9742-41B2908E4544",
      manager: {
        pid: 5841,
        parent: 5831,
        started: "Sat Oct 31 15:18:11 2026",
        executable:
          "/private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24.1.434.0.Mx7b2A/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/runningboardd",
      },
      launcher: {
        pid: 5831,
        parent: 1,
        started: "Sat Oct 31 15:18:11 2026",
        executable: "launchd_sim",
      },
    },
    table:
      " 5831     1 Sat Oct 31 15:18:11 2026     launchd_sim\n 5841  5831 Sat Oct 31 15:18:11 2026     /private/var/run/com.apple.security.cryptexd/mnt/com.apple.iPhoneOS.SimulatorRuntime-v24.1.434.0.Mx7b2A/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot/usr/libexec/runningboardd\n 7060  5831 Sat Oct 31 15:22:08 2026     /Users/admin/Library/Developer/CoreSimulator/Devices/80FC137B-DA21-44F6-9742-41B2908E4544/data/Containers/Bundle/Application/FBBA933F-5B26-44CB-BA1D-19C2EFC98D83/Infinitary.app/Infinitary\n",
    spawned:
      "2026-10-31 15:23:58.206524 (pid/7060/com.apple.WebKit.GPU.46EF075F-A6D3-4FCB-BC0C-11EAF10E08E2 [7387]) <Notice>: xpcproxy_sim spawned with pid 7387",
    running:
      "2026-10-31 15:28:49.557468 (pid/7060/com.apple.WebKit.GPU.46EF075F-A6D3-4FCB-BC0C-11EAF10E08E2 [7387]) <Notice>: service state: running",
  },
] as const;
