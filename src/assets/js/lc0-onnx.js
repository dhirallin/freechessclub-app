importScripts("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/ort.min.js");

let session = null;

// Initialize the ONNX model
async function init(bytearray) {
  ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/';
  session = await ort.InferenceSession.create(bytearray, {
    executionProviders: ['webgpu', 'wasm'],
  });
}

// Run a forward pass
async function forward(batchSize, input, policy, value) {
  const inputName = session.inputNames[0];
  const inputTensor = new ort.Tensor('float32', input, [batchSize, 112, 8, 8]);
  const results = await session.run({ [inputName]: inputTensor });

  const pData = results[session.outputNames[0]].data;
  for(var i = 0; i < policy.length; i++) 
    policy[i] = pData[i];
  const vData = results[session.outputNames[1]].data;
  for(var i = 0; i < value.length; i++) 
    value[i] = vData[i];
}

// Message handler
onmessage = async (e) => {
  const command = e.data.command;
  const doneFlag = e.data.doneFlag;

  switch (command) {
    case 'init':
      try {
        await init(e.data.networkBuffer);
        postMessage({status: 'init-success'});
      }
      catch(err) {
        postMessage({status: 'init-failed', error: err.message });
      }
      break;
    case 'forward':
      try {
        await forward(e.data.batchSize, e.data.input, e.data.policy, e.data.value);
        Atomics.store(doneFlag, 0, 1); 
      }
      catch(err) {
        Atomics.store(doneFlag, 0, 2); 
      }
      Atomics.notify(doneFlag, 0, 1);  
      break;
    default:
      throw new Error('Unknown command: ' + command);
  }
};


