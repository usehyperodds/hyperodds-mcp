// The test vectors in the forecast record's spec, under "EIP-712" (message version 2, mainnet).
export const TEST_KEY = `0x${"0".repeat(63)}1`;
export const TEST_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
export const BTC = { outcome: 42400, market: "BTC above 55,765 on Nov 22 at 06:00 UTC", side: "Yes" };
export const ETH = { outcome: 42501, market: "ETH above 3,000 on Nov 22 at 06:00 UTC", side: "Yes" };
export const vectors = [
  {
    type: "Forecast",
    message: {
      forecaster: TEST_ADDRESS,
      ...BTC,
      probabilityBps: 6200,
      time: 1763719200,
      nonce: "1763719200000",
    },
    digest: "ae6aa9a3a6ef3b2fd8759906d59e200797d8aa2167778389e728d6ab282b5547",
    signature:
      "0xd16082f21b0a948afb6b6989797d76a8998907650777363ca2311c2912e5c5f3492b0b8d51db819b08f072e57e96d1f2533adc9c441b28bbbdde9f190926e4061c",
  },
  {
    type: "ForecastBatch",
    message: {
      forecaster: TEST_ADDRESS,
      forecasts: [
        { ...BTC, probabilityBps: 6200 },
        { ...ETH, probabilityBps: 3100 },
      ],
      time: 1763719200,
      nonce: "1763719200001",
    },
    digest: "46fc072d89b2ed1df1c1c97f00b9afb522deba6f8379065c0de10fcc759f7a6f",
    signature:
      "0xc1188ccdbc21875662dbb6d048b5a2c6eb160cb54333574cbe91339b98aa59aa5666002a6f785cd2e948bb76d8f2e522c88a592b646ec876e0248ce4a1f45ee11b",
  },
];
