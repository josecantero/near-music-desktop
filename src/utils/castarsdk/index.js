const { spawn, execSync } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const enviroment = "prod";

const resourcesPath = process.resourcesPath;

// Cargar koffi para Windows
let koffi;
try {
    koffi = require("koffi");
} catch (e) {
    console.warn("⚠️ No se pudo cargar koffi (solo necesario en Windows):", e.message);
}

let castarProcess = null;        // Proceso SDK (Linux)
let sdkWorker = null;            // Worker thread (Windows)
const pidFile = path.join(__dirname, "castarsdk.pid");

let CLIENT_ID_L = "";
let CLIENT_ID_W = "";

// === Leer claves desde castarCI.json ===
try {
    const configPath = path.join(__dirname, "castarCI.json");
    const raw = fs.readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);

    if (config.clientid_linux) CLIENT_ID_L = config.clientid_linux;
    if (config.clientid_windows) CLIENT_ID_W = config.clientid_windows;
} catch (err) {
    console.error("❌ Error al leer castarCI.json:", err.message || err);
}

// ======== Obtener MAC Address ========
function getMacAddress() {
    try {
        const networkInterfaces = os.networkInterfaces();

        // Buscar la primera interfaz con MAC válida (no virtual)
        for (const [name, interfaces] of Object.entries(networkInterfaces)) {
            // Ignorar interfaces virtuales comunes
            if (name.includes('vEthernet') ||
                name.includes('VMware') ||
                name.includes('VirtualBox') ||
                name.includes('Loopback')) {
                continue;
            }

            for (const iface of interfaces) {
                // Buscar IPv4 no interno
                if (iface.family === 'IPv4' && !iface.internal && iface.mac) {
                    const mac = iface.mac.replace(/-/g, ':').toUpperCase();
                    // Verificar que no sea MAC vacía o virtual
                    if (mac !== '00:00:00:00:00:00') {
                        return mac;
                    }
                }
            }
        }

        // Fallback: primera MAC no vacía
        for (const [name, interfaces] of Object.entries(networkInterfaces)) {
            for (const iface of interfaces) {
                if (iface.mac && iface.mac !== '00:00:00:00:00:00') {
                    return iface.mac.replace(/-/g, ':').toUpperCase();
                }
            }
        }

        throw new Error("No se encontró ninguna MAC address válida");
    } catch (err) {
        console.error("❌ Error obteniendo MAC address:", err.message);
        return null;
    }
}

// ======== Linux helpers ========
function isRunningLinux() {
    try {
        const result = execSync("pidof CastarSdk_amd64").toString();
        //console.log("pgrep result:", result);
        if (!result) return false;
        return true;
    } catch {
        return false;
    }
}

function getLinuxBinaryPath(arch) {
    if (enviroment === "dev") {
        const basePath = path.join(__dirname, "linux-sdk");

        switch (arch) {
            case "x64":
            case "amd64":
            case "x86_64": return path.join(basePath, "CastarSdk_amd64");
            case "ia32":
            case "x86": return path.join(basePath, "CastarSdk_386");
            case "arm": return path.join(basePath, "CastarSdk_arm");
            case "arm64": return path.join(basePath, "CastarSdk_arm64");
            default: throw new Error(`Arquitectura Linux no soportada: ${arch}`);
        }
    }
    else {
        const sdkBinDir = path.join(
            resourcesPath,
            'app.asar.unpacked', // La carpeta creada por asarUnpack
            'castarsdk',         // La carpeta raíz de tu módulo
            'linux-sdk'
        );

        switch (arch) {
            case "x64":
            case "amd64":
            case "x86_64": return path.join(sdkBinDir, "CastarSdk_amd64");
            case "ia32":
            case "x86": return path.join(sdkBinDir, "CastarSdk_386");
            case "arm": return path.join(sdkBinDir, "CastarSdk_arm");
            case "arm64": return path.join(sdkBinDir, "CastarSdk_arm64");
            default: throw new Error(`Arquitectura Linux no soportada: ${arch}`);
        }
    }
}

// ======== Windows helpers ========
function getWindowsDllPath(arch) {
    if (enviroment === "dev") {
        const basePath = path.join(__dirname, "win-sdk");

        switch (arch) {
            case "x64":
            case "amd64":
            case "x86_64": return path.join(basePath, "client_64.dll");
            case "ia32":
            case "x86": return path.join(basePath, "client_386.dll");
            default: throw new Error(`Arquitectura Windows no soportada: ${arch}`);
        }
    }
    else {
        // En producción, la DLL está desempaquetada fuera del asar
        const sdkBinDir = path.join(
            resourcesPath,
            'app.asar.unpacked',
            'castarsdk',
            'win-sdk'
        );

        switch (arch) {
            case "x64":
            case "amd64":
            case "x86_64": return path.join(sdkBinDir, "client_64.dll");
            case "ia32":
            case "x86": return path.join(sdkBinDir, "client_386.dll");
            default: throw new Error(`Arquitectura Windows no soportada: ${arch}`);
        }
    }
}

// Obtener la ruta de koffi para el worker (desempaquetado en producción)
function getKoffiPath() {
    if (enviroment === "dev") {
        return "koffi"; // En desarrollo, require normal funciona
    }
    else {
        // En producción, koffi está desempaquetado
        return path.join(
            resourcesPath,
            'app.asar.unpacked',
            'node_modules',
            'koffi'
        );
    }
}

// ======== Start SDK ========
function startCastarSdk(useDebug = false) {
    const platform = os.platform();
    //console.log(platform);
    const arch = os.arch();

    // ---- Linux ----
    if (platform === "linux") {
        if (castarProcess) {
            console.log("⚠️ CastarSDK ya iniciado en Linux.");
            return;
        }

        let sdkBinaryPath;
        try {
            sdkBinaryPath = getLinuxBinaryPath(arch);
        } catch (err) {
            console.error(err.message);
            return;
        }

        try {
            if (enviroment === "dev") {
                execSync(`chmod +x "${sdkBinaryPath}"`);
            }
            else {
                const child = spawn(sdkBinaryPath, [], {
                    stdio: 'inherit' // Permite ver la salida del binario en la consola
                });
                child.on('error', (err) => {
                    console.error('Error al ejecutar el SDK:', err);
                });
            }
        } catch (err) {
            console.error(err.message);
            return;
        }

        if (isRunningLinux()) {
            console.log("⚠️ CastarSDK ya está corriendo en Linux.");
            return;
        }

        try {
            castarProcess = spawn(sdkBinaryPath, [`-key=${CLIENT_ID_L}`], {
                detached: true,
                stdio: "ignore"
            });
            fs.writeFileSync(pidFile, castarProcess.pid.toString());
            castarProcess.unref();
            //console.log("✅ CastarSDK Linux iniciado con PID:", castarProcess.pid);
        } catch (err) {
            console.error("❌ Error al iniciar CastarSDK en Linux:", err);
        }
        return;
    }

    // ---- Windows ----
    if (platform === "win32") {
        if (sdkWorker) {
            console.log("⚠️ CastarSDK ya está cargado en Windows.");
            return;
        }

        if (!koffi) {
            console.error("❌ koffi no está instalado. Ejecuta: npm install koffi");
            return;
        }

        let dllPath;
        try {
            dllPath = getWindowsDllPath(arch);
        } catch (err) {
            console.error(err.message);
            return;
        }

        if (!fs.existsSync(dllPath)) {
            console.error("❌ No se encontró la DLL de CastarSDK:", dllPath);
            return;
        }

        if (!CLIENT_ID_W) {
            console.error("❌ No se encontró CLIENT_ID_W en castarCI.json");
            return;
        }

        // Obtener MAC Address
        const macAddress = getMacAddress();
        if (!macAddress) {
            console.error("❌ No se pudo obtener la MAC Address");
            return;
        }

        /*console.log("_____________________________________________");
        console.log("📦 CastarSDK Windows Configuration");
        console.log("   DLL:", dllPath);
        console.log("   Client ID:", CLIENT_ID_W);
        console.log("   MAC Address:", macAddress);
        console.log("   Mode:", useDebug ? "DEBUG" : "NORMAL");
        console.log("_____________________________________________");*/

        try {
            const { Worker } = require("worker_threads");
            const is64bit = arch === "x64" || arch === "amd64" || arch === "x86_64";
            const koffiPath = getKoffiPath();

            // Crear código del worker inline (ejecuta DLL en thread separado)
            const workerCode = `
                const { parentPort } = require('worker_threads');
                const koffi = require(${JSON.stringify(koffiPath)});

                const dllPath = ${JSON.stringify(dllPath)};
                const clientId = ${JSON.stringify(CLIENT_ID_W)};
                const macAddress = ${JSON.stringify(macAddress)};
                const is64bit = ${is64bit};
                const useDebug = ${useDebug};

                try {
                    // Cargar la DLL
                    //console.log('📦 Cargando DLL:', dllPath);
                    const lib = koffi.load(dllPath);

                    // Definir el tipo GoString (estructura de Go para strings)
                    const GoString = koffi.struct('GoString', {
                        p: 'str',
                        n: 'int64'
                    });

                    // Definir las funciones exportadas por la DLL
                    const SetDevKey = lib.func('void SetDevKey(GoString key)');
                    const SetDevSn = lib.func('void SetDevSn(GoString sn)');
                    const Start = lib.func('void Start()');
                    const Stop = lib.func('void Stop()');
                    const DebugStart = lib.func('void DebugStart()');

                    // Crear GoString para el clientId
                    const keyGoString = {
                        p: clientId,
                        n: clientId.length
                    };

                    // Crear GoString para el MAC Address (serial number)
                    const snGoString = {
                        p: macAddress,
                        n: macAddress.length
                    };

                    //console.log('🔑 Configurando DevKey:', clientId);
                    SetDevKey(keyGoString);

                    //console.log('🔢 Configurando DevSn (MAC):', macAddress);
                    SetDevSn(snGoString);

                    if (useDebug) {
                        console.log('🐛 Iniciando en modo DEBUG...');
                        DebugStart();
                    } else {
                        //console.log('🚀 Iniciando SDK...');
                        Start();
                    }

                    // Notificar éxito al hilo principal
                    parentPort.postMessage({ type: 'success', message: 'SDK iniciado correctamente' });

                    // Mantener el worker activo
                    setInterval(() => {}, 1000);

                } catch (err) {
                    console.error('❌ Error en worker:', err.message);
                    parentPort.postMessage({ type: 'error', message: err.message, stack: err.stack });
                }
            `;

            console.log("🔄 Iniciando SDK en worker thread...");
            sdkWorker = new Worker(workerCode, { eval: true });

            sdkWorker.on('message', (msg) => {
                if (msg.type === 'success') {
                    console.log("______________________________________________________");
                    console.log("✅ CastarSDK Windows ACTIVO");
                    console.log("   👉 SDK corriendo en worker thread");
                    console.log("   👉 Verifica el panel de control de CastarSDK");
                    console.log("______________________________________________________");
                } else if (msg.type === 'error') {
                    console.error("❌ Error en worker:", msg.message);
                    if (msg.stack) console.error("   Stack:", msg.stack);
                    sdkWorker = null;
                }
            });

            sdkWorker.on('error', (err) => {
                console.error("❌ Error en worker thread:", err.message);
                sdkWorker = null;
            });

            sdkWorker.on('exit', (code) => {
                if (code !== 0) {
                    console.warn(`⚠️ Worker terminó con código: ${code}`);
                }
                sdkWorker = null;
            });

        } catch (err) {
            console.error("❌ Error al crear worker:", err.message);
            console.error("   Stack:", err.stack);
            sdkWorker = null;
        }
        return;
    }

    console.error("❌ Plataforma no soportada:", platform);
}

// ======== Stop SDK ========
function stopCastarSdk() {
    const platform = os.platform();

    if (platform === "linux") {
        if (castarProcess) {
            try {
                castarProcess.kill();
            } catch (err) {
                console.warn("⚠️ Error al detener proceso:", err.message);
            }
            castarProcess = null;
            try {
                fs.unlinkSync(pidFile);
            } catch { }
            console.log("🛑 CastarSDK Linux detenido");
        } else {
            console.log("ℹ️ No hay proceso Linux para detener");
        }
        return;
    }

    if (platform === "win32") {
        if (sdkWorker) {
            try {
                console.log("🛑 Terminando worker thread...");
                sdkWorker.terminate();
                console.log("✅ Worker terminado");
            } catch (err) {
                console.warn("⚠️ Error al terminar worker:", err.message);
            }
            sdkWorker = null;
        } else {
            console.log("ℹ️ CastarSDK Windows no está cargado");
        }
        return;
    }

    console.log("ℹ️ Plataforma no soportada para detener:", platform);
}

// ======== Funciones adicionales ========

/**
 * Inicia el SDK en modo debug
 */
function startDebug() {
    console.log("🐛 Iniciando en modo DEBUG");
    startCastarSdk(true);
}

/**
 * Verifica si el SDK está cargado
 */
function isLoaded() {
    const platform = os.platform();

    if (platform === "linux") {
        return castarProcess !== null;
    }

    if (platform === "win32") {
        return sdkWorker !== null;
    }

    return false;
}

/**
 * Obtiene información del estado del SDK
 */
function getStatus() {
    const platform = os.platform();

    if (platform === "linux") {
        return {
            platform: "linux",
            running: castarProcess !== null,
            pid: castarProcess?.pid || null
        };
    }

    if (platform === "win32") {
        return {
            platform: "windows",
            running: sdkWorker !== null,
            workerActive: sdkWorker !== null,
            macAddress: getMacAddress()
        };
    }

    return {
        platform: platform,
        running: false,
        supported: false
    };
}

// Exportar funciones
module.exports = {
    startCastarSdk,
    stopCastarSdk,
    startDebug,
    isLoaded,
    getStatus,
    getMacAddress  // Exportar para debugging
};
