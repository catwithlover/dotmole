const copyStatus = document.querySelector("#copy-status");
const isTraditionalChinese = document.documentElement.lang
  .toLowerCase()
  .startsWith("zh");

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;

    const originalLabel = button.textContent.trim();
    try {
      await copyText(target.textContent.trim());
      button.textContent = isTraditionalChinese ? "已複製" : "Copied";
      copyStatus.textContent = isTraditionalChinese
        ? "已複製到剪貼簿。"
        : "Copied to clipboard.";
    } catch {
      button.textContent = isTraditionalChinese ? "複製失敗" : "Copy failed";
      copyStatus.textContent = isTraditionalChinese
        ? "無法複製，請手動選取文字。"
        : "Could not copy. Select the text manually.";
    }

    window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 1800);
  });
}
