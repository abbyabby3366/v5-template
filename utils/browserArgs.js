require("dotenv").config();

function getBrowserArgs() {
  const chromeExtraArgs = [
    ...(String(process.env.USE_PUPPETEER_EXTRA_ARGS_GPU).toUpperCase() === "FALSE"
      ? []
      : [
          "--ignore-gpu-blocklist",
          "--enable-gpu-rasterization",
          "--enable-zero-copy",
          "--force-high-performance-gpu",
          "--enable-features=SkiaGraphite",
        ]),
    ...(String(process.env.USE_PUPPETEER_EXTRA_ARGS_NON_GPU).toUpperCase() === "FALSE"
      ? []
      : [
          "--disable-renderer-backgrounding",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-features=CalculateNativeWinOcclusion",
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-notifications",
          "--disable-infobars",
          "--hide-scrollbars",
          "--enable-quic",
          "--enable-parallel-downloading",
        ]),
  ];

  return [
    "--mute-audio",
    "--force-device-scale-factor=1",
    "--high-dpi-support=1",
    ...chromeExtraArgs,
  ];
}

module.exports = { getBrowserArgs };
