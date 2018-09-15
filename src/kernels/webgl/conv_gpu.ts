/**
 * @license
 * Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {Conv2DInfo} from '../../ops/conv_util';
import {GPGPUProgram} from './gpgpu_math';

export class Conv2DProgram implements GPGPUProgram {
  variableNames = ['x', 'W'];
  outputShape: number[];
  userCode: string;

  constructor(convInfo: Conv2DInfo) {
    this.outputShape = convInfo.outShape;
    const padTop = convInfo.padInfo.top;
    const padLeft = convInfo.padInfo.left;
    const strideHeight = convInfo.strideHeight;
    const strideWidth = convInfo.strideWidth;
    const dilationHeight = convInfo.dilationHeight;
    const dilationWidth = convInfo.dilationWidth;
    const filterHeight = convInfo.filterHeight;
    const filterWidth = convInfo.filterWidth;

    const inputDepthNearestVec4 = Math.floor(convInfo.inChannels / 4) * 4;
    const inputDepthVec4Remainder = convInfo.inChannels % 4;

    console.log(inputDepthNearestVec4);
    console.log(inputDepthVec4Remainder);
    console.log(this.outputShape);
    console.log(
        padTop, padLeft, strideHeight, strideWidth, dilationHeight,
        dilationWidth, filterHeight, filterWidth);

    this.userCode = `
      const ivec2 strides = ivec2(${strideHeight}, ${strideWidth});
      const ivec2 pads = ivec2(${padTop}, ${padLeft});

      void main() {
        ivec4 coords = getOutputCoords();
        int batch = coords[0];

        vec4 result = vec4(0);

        int iter = 0;
        int b2 = coords[1];
        ivec2 xRCCorner = coords.yz * strides - pads;

        for(int rIter=0; rIter<=1; rIter++) { // coords.z
          for(int cIter=0; cIter<=1; cIter++) { // coords.w
            int r = rIter + coords.z;
            int c = cIter + coords.w;
            int d2 = c;

            // ivec2 xRCCorner = ivec2(b2, r) * strides - pads;
            int xRCorner = xRCCorner.x;
            int xCCorner = xRCCorner.y;

            // Convolve x(?, ?, d1) with w(:, :, d1, d2) to get y(yR, yC, d2).
            // ? = to be determined. : = across all values in that axis.
            float dotProd = 0.0;
            for (int wR = 0; wR < ${filterHeight}; wR++) {
            // for (int wR = 0; wR < 1; wR++) {
              int xR = xRCorner + wR * ${dilationHeight};

              if (xR < 0 || xR >= ${convInfo.inHeight}) {
                continue;
              }

              for (int wC = 0; wC < ${filterWidth}; wC++) {
              // for (int wC = 0; wC < 1; wC++) {
                int xC = xCCorner + wC * ${dilationWidth};

                if (xC < 0 || xC >= ${convInfo.inWidth}) {
                  continue;
                }

                for (int d1 = 0; d1 < ${inputDepthNearestVec4}; d1 += 4) {
                  vec4 xValues = vec4(
                    getX(batch, xR, xC, d1).x,
                    getX(batch, xR, xC, d1 + 1).x,
                    getX(batch, xR, xC, d1 + 2).x,
                    getX(batch, xR, xC, d1 + 3).x
                  );
                  vec4 wValues = vec4(
                    getW(wR, wC, d1, d2).x,
                    getW(wR, wC, d1 + 1, d2).x,
                    getW(wR, wC, d1 + 2, d2).x,
                    getW(wR, wC, d1 + 3, d2).x
                  );

                  dotProd += dot(xValues, wValues);
                }

                if (${inputDepthVec4Remainder === 1}) {
                  dotProd +=
                    getX(batch, xR, xC, ${inputDepthNearestVec4}).x *
                    getW(wR, wC, ${inputDepthNearestVec4}, d2).x;
                } else if (${inputDepthVec4Remainder === 2}) {
                  vec2 xValues = vec2(
                    getX(batch, xR, xC, ${inputDepthNearestVec4}).x,
                    getX(batch, xR, xC, ${inputDepthNearestVec4} + 1).x
                  );
                  vec2 wValues = vec2(
                    getW(wR, wC, ${inputDepthNearestVec4}, d2).x,
                    getW(wR, wC, ${inputDepthNearestVec4} + 1, d2).x
                  );
                  dotProd += dot(xValues, wValues);
                } else if (${inputDepthVec4Remainder === 3}) {
                  vec3 xValues = vec3(
                    getX(batch, xR, xC, ${inputDepthNearestVec4}).x,
                    getX(batch, xR, xC, ${inputDepthNearestVec4} + 1).x,
                    getX(batch, xR, xC, ${inputDepthNearestVec4} + 2).x
                  );
                  vec3 wValues = vec3( // accurate
                    getW(wR, wC, ${inputDepthNearestVec4}, d2).x,
                    getW(wR, wC, ${inputDepthNearestVec4}, d2).z,
                    getW(wR, wC, ${inputDepthNearestVec4} + 1, d2).x
                  );
                  dotProd += dot(xValues, wValues);
                }
              }
            }

            if(iter == 0) {
              result.x = dotProd;
            } else if(iter == 1) {
              result.y = dotProd;
            } else if(iter == 2) {
              result.z = dotProd;
            } else {
              result.w = dotProd;
            }

            iter = iter + 1;
            // setOutput(dotProd);

          }
        }

        gl_FragColor = result;
      }
    `;
  }
}
