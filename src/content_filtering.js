//import * as nsfwjs from "nsfwjs";

//c'est la chose la plus problèmatique de tous ce code
const BAN_WORD_LIST = [
]

function checkNSFW_image(){
  const img = document.getElementById("img");

  // If you want to host models on your own or use different model from the ones available, see the section "Host your own model".
  const model = await nsfwjs.load();

  // Classify the image
  const predictions = await model.classify(img);
  console.log("Predictions: ", predictions);

}

module.exports = {
  BAN_WORD_LIST
};

