async function ensureMultiplayActive(page) {
  try {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll(".btn-lobby"));
      const multiplayBtn = btns.find(
        (el) => el.innerText && el.innerText.includes("Multiplay"),
      );
      if (multiplayBtn && !multiplayBtn.classList.contains("inactive")) {
        multiplayBtn.click();
      }
    });
  } catch (e) {
    // Ignore errors
  }
}

module.exports = { ensureMultiplayActive };
