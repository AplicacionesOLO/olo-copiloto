"""Agente local — ejecuta DAX contra Power BI DESKTOP en esta computadora.

Para qué sirve: el servicio en Render no puede ver tu Power BI Desktop (corre en
la nube, tu modelo está en tu máquina). Este agente corre acá, junto a Power BI
Desktop, ejecuta las consultas DAX que le pida el servicio, y devuelve las filas.

Cómo se usa (Windows, con Power BI Desktop abierto y el archivo cargado):

    pip install fastapi uvicorn pythonnet
    set AGENT_TOKEN=el-mismo-valor-que-LOCAL_AGENT_TOKEN-en-Render
    python agente_local.py

Y en otra terminal, para exponerlo a internet con un túnel HTTPS:

    cloudflared tunnel --url http://localhost:8787

Cloudflared imprime una URL https://algo.trycloudflare.com — esa URL va en la
variable LOCAL_AGENT_URL de Render, y DATA_BACKEND=agente_local.

Advertencias:
  - Solo funciona mientras esta computadora esté encendida, con Power BI Desktop
    abierto y el túnel corriendo. Si algo de eso se cae, el chat deja de responder.
  - La URL gratuita de cloudflared cambia cada vez que reinicias el túnel; hay que
    actualizar LOCAL_AGENT_URL en Render cada vez (un túnel con nombre y dominio
    propio evita eso).
  - El token es lo único que separa tu modelo de internet. Que sea largo y aleatorio.
"""
from __future__ import annotations

import glob
import os
import secrets
import sys
from typing import Any

from fastapi import Body, FastAPI, Header, HTTPException

AGENT_TOKEN = os.getenv("AGENT_TOKEN", "")
PUERTO = int(os.getenv("AGENT_PORT", "8787"))

RUTAS_ADOMD = [
    r"C:\Program Files\Microsoft.NET\ADOMD.NET\160",
    r"C:\Program Files\Microsoft.NET\ADOMD.NET\150",
    r"C:\Program Files\Microsoft.NET\ADOMD.NET\140",
    r"C:\Program Files\Microsoft Power BI Desktop\bin",
    r"C:\Program Files\WindowsApps",  # versión de Microsoft Store (se busca en profundidad)
]

app = FastAPI(title="Agente local Power BI Desktop", docs_url=None, redoc_url=None)
_adomd_listo = False


def cargar_adomd() -> None:
    """Carga la librería ADOMD.NET, que viene con Power BI Desktop o SSMS."""
    global _adomd_listo
    if _adomd_listo:
        return
    try:
        import clr  # noqa: PLC0415  (pythonnet)
    except ImportError as exc:
        raise RuntimeError(
            "Falta pythonnet. Instalalo con:  pip install pythonnet"
        ) from exc

    candidatos: list[str] = []
    for ruta in RUTAS_ADOMD:
        dll = os.path.join(ruta, "Microsoft.AnalysisServices.AdomdClient.dll")
        if os.path.exists(dll):
            candidatos.append(ruta)
    # Búsqueda de respaldo, por si está en otra versión/ubicación
    if not candidatos:
        for patron in (
            r"C:\Program Files\Microsoft.NET\ADOMD.NET\*\Microsoft.AnalysisServices.AdomdClient.dll",
            r"C:\Program Files (x86)\Microsoft.NET\ADOMD.NET\*\Microsoft.AnalysisServices.AdomdClient.dll",
        ):
            for hallado in glob.glob(patron):
                candidatos.append(os.path.dirname(hallado))

    if not candidatos:
        raise RuntimeError(
            "No encontré Microsoft.AnalysisServices.AdomdClient.dll. Viene con Power BI "
            "Desktop y con SQL Server Management Studio. Instalá 'ADOMD.NET' del feature "
            "pack de SQL Server, o agregá su carpeta a RUTAS_ADOMD en este archivo."
        )

    for ruta in candidatos:
        if ruta not in sys.path:
            sys.path.append(ruta)
    clr.AddReference("Microsoft.AnalysisServices.AdomdClient")
    _adomd_listo = True


def descubrir_puerto() -> int:
    """Lee el puerto del motor de Analysis Services que Power BI Desktop levantó."""
    local = os.getenv("LOCALAPPDATA", "")
    patrones = [
        os.path.join(local, "Microsoft", "Power BI Desktop",
                     "AnalysisServicesWorkspaces", "*", "Data", "msmdsrv.port.txt"),
        os.path.join(local, "Packages", "Microsoft.MicrosoftPowerBIDesktop_8wekyb3d8bbwe",
                     "LocalCache", "Local", "Microsoft", "Power BI Desktop Store App",
                     "AnalysisServicesWorkspaces", "*", "Data", "msmdsrv.port.txt"),
    ]
    archivos: list[str] = []
    for patron in patrones:
        archivos.extend(glob.glob(patron))
    if not archivos:
        raise RuntimeError(
            "No hay ninguna instancia de Power BI Desktop corriendo (no encontré "
            "msmdsrv.port.txt). Abrí el archivo .pbix y volvé a intentar."
        )
    # El más reciente es la instancia activa
    archivos.sort(key=os.path.getmtime, reverse=True)
    with open(archivos[0], "rb") as fh:
        crudo = fh.read()
    texto = crudo.decode("utf-16-le", errors="ignore").strip().lstrip("\ufeff")
    digitos = "".join(c for c in texto if c.isdigit())
    if not digitos:
        texto = crudo.decode("utf-8", errors="ignore").strip()
        digitos = "".join(c for c in texto if c.isdigit())
    if not digitos:
        raise RuntimeError(f"No pude leer el puerto desde {archivos[0]}")
    return int(digitos)


def _catalogo(puerto: int) -> str:
    """Nombre de la base de datos (el modelo) que Power BI Desktop tiene cargada."""
    from Microsoft.AnalysisServices.AdomdClient import AdomdConnection  # noqa: PLC0415

    con = AdomdConnection(f"Data Source=localhost:{puerto};")
    con.Open()
    try:
        cmd = con.CreateCommand()
        cmd.CommandText = "select [CATALOG_NAME] from $SYSTEM.DBSCHEMA_CATALOGS"
        lector = cmd.ExecuteReader()
        try:
            if lector.Read():
                return str(lector[0])
        finally:
            lector.Close()
    finally:
        con.Close()
    raise RuntimeError("Power BI Desktop está abierto pero no tiene ningún modelo cargado.")


def ejecutar_dax(consulta: str) -> list[dict[str, Any]]:
    cargar_adomd()
    from Microsoft.AnalysisServices.AdomdClient import AdomdConnection  # noqa: PLC0415

    puerto = descubrir_puerto()
    catalogo = _catalogo(puerto)
    con = AdomdConnection(f"Data Source=localhost:{puerto};Catalog={catalogo};")
    con.Open()
    try:
        cmd = con.CreateCommand()
        cmd.CommandText = consulta
        lector = cmd.ExecuteReader()
        try:
            columnas = [lector.GetName(i) for i in range(lector.FieldCount)]
            filas: list[dict[str, Any]] = []
            while lector.Read():
                fila = {}
                for i, col in enumerate(columnas):
                    valor = lector[i]
                    fila[col] = None if valor is None else _py(valor)
                filas.append(fila)
                if len(filas) >= 50000:
                    break
            return filas
        finally:
            lector.Close()
    finally:
        con.Close()


def _py(valor: Any) -> Any:
    """Convierte tipos .NET a algo que se pueda serializar a JSON."""
    try:
        import System  # noqa: PLC0415

        if isinstance(valor, System.DateTime):
            return valor.ToString("yyyy-MM-ddTHH:mm:ss")
        if isinstance(valor, System.Decimal):
            return float(System.Convert.ToDouble(valor))
    except Exception:  # noqa: BLE001
        pass
    if isinstance(valor, (int, float, str, bool)):
        return valor
    return str(valor)


def _autenticar(token: str | None) -> None:
    if not AGENT_TOKEN:
        raise HTTPException(
            status_code=500,
            detail="El agente no tiene AGENT_TOKEN configurado. Definilo antes de arrancar.",
        )
    if not token or not secrets.compare_digest(token, AGENT_TOKEN):
        raise HTTPException(status_code=401, detail="Token inválido.")


@app.get("/salud")
def salud() -> dict[str, Any]:
    try:
        return {"ok": True, "puerto_powerbi": descubrir_puerto()}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


@app.post("/dax")
def dax(
    payload: dict[str, Any] = Body(...),
    x_agent_token: str | None = Header(default=None, alias="x-agent-token"),
) -> dict[str, Any]:
    _autenticar(x_agent_token)
    consulta = (payload.get("consulta") or "").strip()
    if not consulta:
        return {"ok": False, "error": "Falta el campo 'consulta'."}
    if not consulta.upper().lstrip().startswith(("EVALUATE", "DEFINE")):
        return {"ok": False, "error": "Solo se aceptan consultas EVALUATE / DEFINE."}
    try:
        filas = ejecutar_dax(consulta)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "filas": filas, "total": len(filas)}


if __name__ == "__main__":
    import uvicorn

    if not AGENT_TOKEN:
        print("ATENCIÓN: falta la variable AGENT_TOKEN. Definila antes de arrancar:")
        print("   set AGENT_TOKEN=una-cadena-larga-y-aleatoria")
        raise SystemExit(1)
    print(f"Agente local escuchando en http://localhost:{PUERTO}")
    print("Exponelo con:  cloudflared tunnel --url http://localhost:%d" % PUERTO)
    uvicorn.run(app, host="127.0.0.1", port=PUERTO)
