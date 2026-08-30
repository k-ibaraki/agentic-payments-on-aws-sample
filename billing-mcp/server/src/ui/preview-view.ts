import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "HTML Preview", version: "0.1.0" });

const previewFrame = document.getElementById("preview") as HTMLIFrameElement;
const downloadBtn = document.getElementById(
  "download-btn",
) as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;

let currentHtml = "";
let currentFilename = "generated.html";

app.ontoolresult = (result: Record<string, unknown>) => {
  const sc = result?.structuredContent as
    | { html: string; filename?: string }
    | undefined;
  if (!sc?.html) return;

  currentHtml = sc.html;
  currentFilename = sc.filename ?? "generated.html";

  previewFrame.srcdoc = currentHtml;
  downloadBtn.style.display = "inline-block";
  statusEl.textContent = "プレビュー表示中";
};

downloadBtn.addEventListener("click", async () => {
  await app.downloadFile({
    contents: [
      {
        type: "resource",
        resource: {
          uri: `file:///${currentFilename}`,
          mimeType: "text/html",
          text: currentHtml,
        },
      },
    ],
  });
});

app.connect();
