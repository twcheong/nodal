"""Submit saved graphs to local nodal and retain receipts, outputs and hashes."""

import argparse
import hashlib
import json
import urllib.error
import urllib.request
from pathlib import Path


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def request(url: str, body: object | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(exc.read().decode()) from exc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["submit", "status", "inspect"])
    parser.add_argument("--request", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8210")
    args = parser.parse_args()
    if args.action == "inspect":
        nodes = request(args.url + "/api/nodes")
        write_json(Path(__file__).parent / "nodes.json", nodes)
        print(json.dumps(nodes, ensure_ascii=False))
        return
    job = json.loads(args.request.read_text(encoding="utf-8"))
    stem = args.request.name.removesuffix(".request.json")
    receipt_path = args.request.with_name(stem + ".receipt.json")
    if args.action == "submit":
        if receipt_path.exists():
            raise RuntimeError("Receipt exists; inspect the previous run before any resubmission.")
        graph = job["graph"]
        check = request(args.url + "/api/graph/validate", {"graph": graph})
        write_json(args.request.with_name(stem + ".validation.json"), check)
        if not check["valid"]:
            raise RuntimeError(json.dumps(check, ensure_ascii=False))
        receipt = request(
            args.url + "/api/runs", {"graph": graph, "priority": int(job.get("priority", 0))}
        )
        receipt["server_url"] = args.url
        write_json(receipt_path, receipt)
        print(json.dumps(receipt))
        return
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    result = request(receipt["server_url"] + "/api/runs/" + receipt["run_id"])
    write_json(args.request.with_name(stem + ".status.json"), result)
    files = []
    if result["status"] == "succeeded":
        for node_id, filename in job.get("save_outputs", {}).items():
            for output in result["outputs"][node_id]:
                asset = output.get("asset")
                if asset is None:
                    continue
                with urllib.request.urlopen(
                    receipt["server_url"] + "/api/assets/" + asset["hash"], timeout=60
                ) as response:
                    data = response.read()
                target = args.request.parent / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                files.append(
                    {
                        "file": filename,
                        "asset": asset["hash"],
                        "sha256": hashlib.sha256(data).hexdigest(),
                    }
                )
        write_json(args.request.with_name(stem + ".files.json"), files)
    print(
        json.dumps(
            {
                "run_id": result["run_id"],
                "status": result["status"],
                "error": result.get("error"),
                "files": files,
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
