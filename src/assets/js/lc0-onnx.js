importScripts("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/ort.min.js");

let session = null;

// Initialize the ONNX model
async function init(modelUrl) {
  session = await ort.InferenceSession.create(modelUrl);
  postMessage({ type: 'init', status: 'done' });
}

// Run a forward pass
async function forward(inputArray, batchSize) {
  const session = this.model;
  const inputName = session.inputNames[0];
  const dims = [...session.inputMetadata[inputName].dimensions];
  dims[0] = batch_size;
  const inputTensor = new ort.Tensor('float32', input, dims);
  const results = await session.run({ [inputName]: inputTensor });

  const p_data = results[session.outputNames[0]].data;
  for(var i = 0; i < policy.length; i++) 
    policy[i] = p_data[i];
  const v_data = results[session.outputNames[1]].data;
  for(var i = 0; i < value.length; i++) 
    value[i] = v_data[i];

  Atomics.store(this.forwardSyncFlag, 0, 1); 
  Atomics.notify(this.forwardSyncFlag, 0, 1);  
}

// Message handler
onmessage = async (e) => {
  const { cmd, payload } = e.data;

  try {
    switch (cmd) {
      case 'init':
        await init(payload.modelUrl);
        break;
      case 'forward':
        await forward(payload.inputArray, payload.batchSize);
        break;
      default:
        throw new Error('Unknown command: ' + cmd);
    }
  } catch (err) {
    postMessage({ type: 'error', message: err.message });
  }
};