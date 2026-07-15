import { byId } from "../lib/dom";

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

/** Owns transient browser attachment state and object-URL cleanup. */
export function createAttachments() {
    const attachments: Array<{ data: string; mediaType: string; url: string }> = [];

    function render(): void {
        const container = byId("attachments");
        container.classList.toggle("visible", attachments.length > 0);
        container.innerHTML = "";
        attachments.forEach((attachment, index) => {
            const item = document.createElement("div");
            item.className = "att";
            const image = document.createElement("img");
            image.src = attachment.url;
            const remove = document.createElement("button");
            remove.textContent = "x";
            remove.title = "remove";
            remove.onclick = () => {
                URL.revokeObjectURL(attachment.url);
                attachments.splice(index, 1);
                render();
            };
            item.append(image, remove);
            container.appendChild(item);
        });
    }

    function clear(): void {
        for (const attachment of attachments) URL.revokeObjectURL(attachment.url);
        attachments.length = 0;
        render();
    }

    function attach(file: File | null): void {
        if (!file || !IMAGE_TYPES.has(file.type) || attachments.length >= 8) return;
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result);
            attachments.push({
                data: dataUrl.slice(dataUrl.indexOf(",") + 1),
                mediaType: file.type,
                url: URL.createObjectURL(file),
            });
            render();
        };
        reader.readAsDataURL(file);
    }

    return { attachments, attach, clear };
}
