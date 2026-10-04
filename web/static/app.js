document.addEventListener("DOMContentLoaded", () => {
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");
    const preview = document.getElementById("preview");
    const renderBtn = document.getElementById("render-btn");
    const resetBtn = document.getElementById("reset-btn");
    const loading = document.getElementById("loading");
    const results = document.getElementById("results");
    const asciiText = document.getElementById("ascii-text");
    const asciiImage = document.getElementById("ascii-image");
    const copyBtn = document.getElementById("copy-btn");
    const downloadBtn = document.getElementById("download-btn");
    const downloadSvgBtn = document.getElementById("download-svg-btn");
    const statsEl = document.getElementById("stats");
    const loadingText = document.getElementById("loading-text");

    // Sliders
    const maxWidth = document.getElementById("max-width");
    const widthDisplay = document.getElementById("width-display");
    const globalContrast = document.getElementById("global-contrast");
    const gcDisplay = document.getElementById("gc-display");
    const dirContrast = document.getElementById("dir-contrast");
    const dcDisplay = document.getElementById("dc-display");

    let selectedFile = null;
    let currentPngBase64 = null;
    let currentSvgBase64 = null;
    let currentGifBase64 = null;

    // Slider value updates
    maxWidth.addEventListener("input", () => { widthDisplay.textContent = maxWidth.value; });
    globalContrast.addEventListener("input", () => { gcDisplay.textContent = parseFloat(globalContrast.value).toFixed(1); });
    dirContrast.addEventListener("input", () => { dcDisplay.textContent = parseFloat(dirContrast.value).toFixed(1); });

    // Reset button
    resetBtn.addEventListener("click", () => {
        maxWidth.value = 120;
        widthDisplay.textContent = "120";
        globalContrast.value = 2.0;
        gcDisplay.textContent = "2.0";
        dirContrast.value = 3.0;
        dcDisplay.textContent = "3.0";
    });

    // Drop zone events
    dropZone.addEventListener("click", () => fileInput.click());

    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
    });

    dropZone.addEventListener("dragleave", () => {
        dropZone.classList.remove("dragover");
    });

    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length > 0) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) {
            handleFile(fileInput.files[0]);
        }
    });

    // Clipboard paste support (Ctrl+V)
    document.addEventListener("paste", (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith("image/")) {
                e.preventDefault();
                handleFile(item.getAsFile());
                return;
            }
        }
    });

    function handleFile(file) {
        if (!file.type.startsWith("image/")) {
            alert("Please select an image file.");
            return;
        }
        selectedFile = file;
        renderBtn.disabled = false;

        // Show preview
        const reader = new FileReader();
        reader.onload = (e) => {
            preview.src = e.target.result;
            preview.classList.remove("hidden");
        };
        reader.readAsDataURL(file);
    }

    // Helper: switch to a specific tab
    function switchToTab(tabName) {
        document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
        document.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
        const targetTab = document.querySelector(`.tab[data-tab="${tabName}"]`);
        if (targetTab) targetTab.classList.add("active");
        const targetContent = document.getElementById("tab-" + tabName);
        if (targetContent) targetContent.classList.remove("hidden");
    }

    // Reset UI to non-GIF state
    function resetGifState() {
        currentGifBase64 = null;
        downloadBtn.textContent = "Download PNG";
        downloadSvgBtn.classList.remove("hidden");
    }

    // Render
    renderBtn.addEventListener("click", async () => {
        if (!selectedFile) return;

        const isGif = selectedFile.type === "image/gif";

        // Update loading message
        loadingText.textContent = isGif
            ? "Rendering ASCII animation... (this may take a moment)"
            : "Rendering ASCII art...";

        loading.classList.remove("hidden");
        results.classList.add("hidden");
        renderBtn.disabled = true;
        resetGifState();

        const formData = new FormData();
        formData.append("file", selectedFile);
        formData.append("max_width", maxWidth.value);
        formData.append("global_contrast", globalContrast.value);
        formData.append("directional_contrast", dirContrast.value);

        try {
            if (isGif) {
                // GIF rendering path
                const response = await fetch("/render-gif", {
                    method: "POST",
                    body: formData,
                });

                const data = await response.json();

                if (data.error) {
                    alert("Error: " + data.error);
                    return;
                }

                asciiText.textContent = data.text;
                asciiImage.src = "data:image/gif;base64," + data.gif_base64;
                currentGifBase64 = data.gif_base64;
                currentPngBase64 = null;
                currentSvgBase64 = null;

                statsEl.textContent = `${data.frame_count} frames rendered to ASCII animation`;

                // Update buttons for GIF mode
                downloadBtn.textContent = "Download GIF";
                downloadSvgBtn.classList.add("hidden");

                // Auto-switch to Image tab (animated GIF is the main output)
                switchToTab("image");

                results.classList.remove("hidden");
            } else {
                // Normal image rendering path
                const response = await fetch("/render", {
                    method: "POST",
                    body: formData,
                });

                const data = await response.json();

                if (data.error) {
                    alert("Error: " + data.error);
                    return;
                }

                asciiText.textContent = data.text;
                asciiImage.src = "data:image/png;base64," + data.image_base64;
                currentPngBase64 = data.image_base64;
                currentSvgBase64 = data.svg_base64;

                statsEl.textContent = `${data.cols} x ${data.rows} characters | Cache: ${data.cache_stats.entries} entries, ${(data.cache_stats.hit_rate * 100).toFixed(1)}% hit rate`;

                results.classList.remove("hidden");
            }
        } catch (err) {
            alert("Failed to render: " + err.message);
        } finally {
            loading.classList.add("hidden");
            renderBtn.disabled = false;
        }
    });

    // Tab switching
    document.querySelectorAll(".tab").forEach((tab) => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
            tab.classList.add("active");
            document.getElementById("tab-" + tab.dataset.tab).classList.remove("hidden");
        });
    });

    // Copy text
    copyBtn.addEventListener("click", async () => {
        const text = asciiText.textContent;
        try {
            await navigator.clipboard.writeText(text);
            copyBtn.textContent = "Copied!";
            setTimeout(() => { copyBtn.textContent = "Copy Text"; }, 2000);
        } catch {
            // Fallback
            const textarea = document.createElement("textarea");
            textarea.value = text;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            copyBtn.textContent = "Copied!";
            setTimeout(() => { copyBtn.textContent = "Copy Text"; }, 2000);
        }
    });

    // Download PNG or GIF
    downloadBtn.addEventListener("click", () => {
        const a = document.createElement("a");
        if (currentGifBase64) {
            a.href = "data:image/gif;base64," + currentGifBase64;
            a.download = "ascii_art.gif";
        } else if (currentPngBase64) {
            a.href = "data:image/png;base64," + currentPngBase64;
            a.download = "ascii_art.png";
        } else {
            return;
        }
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });

    // Download SVG
    downloadSvgBtn.addEventListener("click", () => {
        if (!currentSvgBase64) return;
        const a = document.createElement("a");
        a.href = "data:image/svg+xml;base64," + currentSvgBase64;
        a.download = "ascii_art.svg";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });
});
