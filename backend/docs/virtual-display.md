# Virtual Display (IDDCX indirect display driver)

`src/core/workspace/VirtualDisplayManager.ts` drives extra "virtual monitors" so
Umbra's swarm can run several isolated AI workers as if each had its own screen.
On Windows a virtual monitor can only be created by a **kernel-mode Indirect
Display Driver (IDDCX)** — there is no user-mode API. Until that driver is
installed, `src/native/win32/VirtualDisplayNative.ts` stays a stub that
simulates display buffers so the rest of the stack runs and tests green.

This document explains how to build and install the real driver. It is the one
feature in the repo that requires driver signing and a reboot — it cannot be
done purely from Node.js.

## 1. Prerequisites

- **Visual Studio 2022** with the *Desktop development with C++* workload
  (or the Build Tools + the Windows SDK) — the same toolchain used for the Rust
  mesh (see `mesh/README.md`).
- **Windows Driver Kit (WDK)** for your SDK version. The `winget` id is
  `Microsoft.WindowsWDK.10.0.26100` (adjust to your SDK build).
- An **Administrator** shell, and willingness to reboot into **test-signing
  mode** (self-signed drivers only load in test mode).

## 2. Build the Microsoft sample driver

Microsoft ships a complete, MIT-licensed IDDCX sample that already implements a
virtual monitor with configurable resolution:

```powershell
git clone https://github.com/microsoft/Windows-driver-samples.git
cd Windows-driver-samples\video\IndirectDisplay
```

Open `IddSampleDriver.sln` in Visual Studio, select the
`IddSampleDriver` project and the **x64 / Release** configuration, and build.
The output is `IddSampleDriver.sys` + `IddSampleDriver.inf`.

## 3. Enable test signing (one-time)

Self-signed drivers only load when the boot configuration allows it:

```powershell
bcdedit /set testsigning on
# reboot
```

Production signing (WHQL) requires a Microsoft EV certificate and the Hardware
Developer Program — out of scope for a local build; test mode is sufficient for
development.

## 4. Install the driver

```powershell
pnputil /add-driver IddSampleDriver.inf /install
```

The virtual monitor appears immediately (or after a reboot). Configure the
resolution the driver exposes by editing the `IddSampleDriver.inf` (the sample
reads its mode list from the driver build, defaulting to 2560x1440@60).

## 5. Point Umbra at it

Once the driver is installed, replace the stub in
`src/native/win32/VirtualDisplayNative.ts` with a loader that speaks to the
driver via the WDK's device-control interface (or use the sample's own
`IddSampleDriverApp.exe` for testing). The manager interface
(`createVirtualDisplay` / `destroyVirtualDisplay` / `sendFrameToDisplay` /
`captureDisplayBuffer`) is already the contract the driver must satisfy.

## Why this is the last feature

Everything else in the repo runs in user mode. A virtual monitor is the single
capability that Windows only exposes to signed kernel drivers, which is why it
is a stub rather than a normal TS module. The stub is intentional and safe:
every caller degrades to the real physical display when no driver is present.
