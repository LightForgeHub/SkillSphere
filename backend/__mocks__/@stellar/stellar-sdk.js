const mocks = {};

function mockVerify(data, signature) {
  if (mocks.verifyResult !== undefined) {
    return mocks.verifyResult;
  }
  return true;
}

const Keypair = {
  fromPublicKey: jest.fn((pubKey) => ({
    publicKey: () => pubKey,
    verify: mockVerify,
    sign: jest.fn((data) => {
      const sig = Buffer.alloc(64);
      data.copy(sig);
      return sig;
    }),
  })),
  random: jest.fn(() => ({
    publicKey: () => "GTESTKEY",
    secretKey: new Uint8Array(64),
    sign: jest.fn((data) => {
      const sig = Buffer.alloc(64);
      data.copy(sig);
      return sig;
    }),
  })),
};

module.exports = {
  Keypair,
  setMockVerifyResult: (val) => {
    mocks.verifyResult = val;
  },
  setMockPublicKey: (val) => {
    mocks.publicKey = val;
  },
  clearMocks: () => {
    mocks.verifyResult = undefined;
    mocks.publicKey = undefined;
  },
};