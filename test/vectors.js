// The contract's test vectors: docs/feature/forecasts.md, "EIP-712".
export const TEST_KEY = `0x${"0".repeat(63)}1`;
export const TEST_ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
export const vectors = [
  {
    type: "Forecast",
    message: {
      forecaster: TEST_ADDRESS,
      outcome: 42400,
      probabilityBps: 6200,
      time: 1763719200,
      nonce: "1763719200000",
    },
    digest: "9d68b0769b49c457471adea46b361ce9f832bb2e5bbf8199689d357766c9e754",
    signature:
      "0x4d8ddebb9cfe6cfcc6d870809f19364c56e134039c1200cf74004ce6aac7a1ed09c333b798001f1c2cd2d8aa37630592e3d5333abc30b6a479c0db8bd213cd651c",
  },
  {
    type: "ForecastBatch",
    message: {
      forecaster: TEST_ADDRESS,
      forecasts: [
        { outcome: 42400, probabilityBps: 6200 },
        { outcome: 42501, probabilityBps: 3100 },
      ],
      time: 1763719200,
      nonce: "1763719200001",
    },
    digest: "8628ebe750cec7b7704023cfeb8cbfde075fde486849a3ae9c8931fabc83c139",
    signature:
      "0xf905beb040b0c94625daeb3318c3be48580ec010fec6400f70493dcd3e74c6165dd78927190c61761f03214a1b8a2d065b393ae106adf26edd0b359a2ba1bcd71b",
  },
];
