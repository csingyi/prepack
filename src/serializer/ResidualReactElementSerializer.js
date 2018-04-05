/**
 * Copyright (c) 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

/* @flow */

import { Realm } from "../realm.js";
import { ResidualHeapSerializer } from "./ResidualHeapSerializer.js";
import { canHoistReactElement } from "../react/hoisting.js";
import * as t from "babel-types";
import type { BabelNode, BabelNodeExpression } from "babel-types";
import {
  ArrayValue,
  NumberValue,
  Value,
  ObjectValue,
  StringValue,
  SymbolValue,
  AbstractValue,
} from "../values/index.js";
import { convertExpressionToJSXIdentifier, convertKeyValueToJSXAttribute } from "../react/jsx.js";
import { Logger } from "../utils/logger.js";
import invariant from "../invariant.js";
import { FatalError } from "../errors";
import { getReactSymbol, getProperty } from "../react/utils.js";
import type { ReactOutputTypes } from "../options.js";
import type { LazilyHoistedNodes } from "./types.js";

type ReactElementAttributeType = "SPREAD" | "PROPERTY" | "PENDING";
type ReactElementChildType = "NORMAL" | "PENDING";

type ReactElementChild = {
  expr: void | BabelNodeExpression,
  type: ReactElementChildType,
};

type ReactElementAttribute = {
  expr: void | BabelNodeExpression,
  key: void | string,
  type: ReactElementAttributeType,
};

type ReactElement = {
  attributes: Array<ReactElementAttribute>,
  children: Array<ReactElementChild>,
  declared: boolean,
  type: void | BabelNodeExpression,
  value: ObjectValue,
};

export class ResidualReactElementSerializer {
  constructor(realm: Realm, residualHeapSerializer: ResidualHeapSerializer) {
    this.realm = realm;
    this.residualHeapSerializer = residualHeapSerializer;
    this.logger = residualHeapSerializer.logger;
    this.reactOutput = realm.react.output || "create-element";
    this._lazilyHoistedNodes = undefined;
  }

  realm: Realm;
  logger: Logger;
  reactOutput: ReactOutputTypes;
  residualHeapSerializer: ResidualHeapSerializer;
  _lazilyHoistedNodes: void | LazilyHoistedNodes;

  _createReactElement(value: ObjectValue): ReactElement {
    return { attributes: [], children: [], declared: false, type: undefined, value };
  }

  _createReactElementAttribute(): ReactElementAttribute {
    return { expr: undefined, key: undefined, type: "PENDING" };
  }

  _createReactElementChild(): ReactElementChild {
    return { expr: undefined, type: "PENDING" };
  }

  _emitHoistedReactElement(
    id: BabelNodeExpression,
    reactElement: BabelNodeExpression,
    hoistedCreateElementIdentifier: BabelNodeIdentifier,
    originalCreateElementIdentifier: BabelNodeIdentifier
  ) {
    // if the currentHoistedReactElements is not defined, we create it an emit the function call
    // this should only occur once per additional function
    if (this._lazilyHoistedNodes === undefined) {
      let funcId = t.identifier(this.residualHeapSerializer.functionNameGenerator.generate());
      this._lazilyHoistedNodes = {
        id: funcId,
        createElementIdentifier: hoistedCreateElementIdentifier,
        nodes: [],
      };
      let statement = t.expressionStatement(
        t.logicalExpression(
          "&&",
          t.binaryExpression("===", id, t.unaryExpression("void", t.numericLiteral(0), true)),
          // pass the createElementIdentifier if it's not null
          t.callExpression(funcId, originalCreateElementIdentifier ? [originalCreateElementIdentifier] : [])
        )
      );
      this.residualHeapSerializer.emitter.emit(statement);
    }
    // we then push the reactElement and its id into our list of elements to process after
    // the current additional function has serialzied
    invariant(this._lazilyHoistedNodes !== undefined);
    invariant(Array.isArray(this._lazilyHoistedNodes.nodes));
    this._lazilyHoistedNodes.nodes.push({ id, astNode: reactElement });
  }

  _getReactLibraryValue() {
    let reactLibraryObject = this.realm.fbLibraries.react;
    // if there is no React library, then we should throw and error
    if (reactLibraryObject === undefined) {
      throw new FatalError("unable to find React library reference in scope");
    }
    return reactLibraryObject;
  }

  _getReactCreateElementValue() {
    let reactLibraryObject = this._getReactLibraryValue();
    return getProperty(this.realm, reactLibraryObject, "createElement");
  }

  _emitReactElement(reactElement: ReactElement): BabelNodeExpression {
    let { value } = reactElement;
    let shouldHoist =
      this.residualHeapSerializer.isReferencedOnlyByAdditionalFunction(value) !== undefined &&
      canHoistReactElement(this.realm, value);

    let id = this.residualHeapSerializer.getSerializeObjectIdentifier(value);
    // this identifier is used as the deafult, but also passed to the hoisted factory function
    let originalCreateElementIdentifier = null;
    // this name is used when hoisting, and is passed into the factory function, rather than the original
    let hoistedCreateElementIdentifier = null;
    let reactElementAstNode;

    this.residualHeapSerializer.emitter.emitNowOrAfterWaitingForDependencies([value], () => {
      if (this.reactOutput === "jsx") {
        reactElementAstNode = this._serializeReactElementToJSXElement(value, reactElement);
      } else if (this.reactOutput === "create-element") {
        let createElement = this._getReactCreateElementValue();
        originalCreateElementIdentifier = this.residualHeapSerializer.serializeValue(createElement);

        if (shouldHoist) {
          // if we haven't created a _lazilyHoistedNodes before, then this is the first time
          // so we only create the hoisted identifier once
          if (this._lazilyHoistedNodes === undefined) {
            // create a new unique instance
            hoistedCreateElementIdentifier = t.identifier(
              this.residualHeapSerializer.intrinsicNameGenerator.generate()
            );
          } else {
            hoistedCreateElementIdentifier = this._lazilyHoistedNodes.createElementIdentifier;
          }
        }

        let createElementIdentifier = shouldHoist ? hoistedCreateElementIdentifier : originalCreateElementIdentifier;
        reactElementAstNode = this._serializeReactElementToCreateElement(value, reactElement, createElementIdentifier);
      } else {
        invariant(false, "Unknown reactOutput specified");
      }
      // if we are hoisting this React element, put the assignment in the body
      // also ensure we are in an additional function
      if (shouldHoist) {
        this._emitHoistedReactElement(
          id,
          reactElementAstNode,
          hoistedCreateElementIdentifier,
          originalCreateElementIdentifier
        );
      } else {
        if (reactElement.declared) {
          this.residualHeapSerializer.emitter.emit(
            t.expressionStatement(t.assignmentExpression("=", id, reactElementAstNode))
          );
        } else {
          reactElement.declared = true;
          this.residualHeapSerializer.emitter.emit(
            t.variableDeclaration("var", [t.variableDeclarator(id, reactElementAstNode)])
          );
        }
      }
    });
    return id;
  }

  _serializeNowOrAfterWaitingForDependencies(
    value: Value,
    reactElement: ReactElement,
    func: () => void | BabelNode,
    shouldSerialize?: boolean = true
  ): void {
    let reason = this.residualHeapSerializer.emitter.getReasonToWaitForDependencies(value);

    const serialize = () => {
      func();
    };

    if (reason) {
      this.residualHeapSerializer.emitter.emitAfterWaiting(reason, [value], () => {
        serialize();
        this._emitReactElement(reactElement);
      });
    } else {
      serialize();
    }
  }

  _serializeReactFragmentType(typeValue: SymbolValue): BabelNodeExpression {
    let reactLibraryObject = this._getReactLibraryValue();
    // we want to visit the Symbol type, but we don't want to serialize it
    // as this is a React internal
    this.residualHeapSerializer.serializedValues.add(typeValue);
    invariant(typeValue.$Description instanceof StringValue);
    this.residualHeapSerializer.serializedValues.add(typeValue.$Description);
    return t.memberExpression(this.residualHeapSerializer.serializeValue(reactLibraryObject), t.identifier("Fragment"));
  }

  _serializeReactElementType(reactElement: ReactElement): void {
    let { value } = reactElement;
    let typeValue = getProperty(this.realm, value, "type");

    this._serializeNowOrAfterWaitingForDependencies(typeValue, reactElement, () => {
      let expr;

      if (typeValue instanceof SymbolValue && typeValue === getReactSymbol("react.fragment", this.realm)) {
        expr = this._serializeReactFragmentType(typeValue);
      } else {
        expr = this.residualHeapSerializer.serializeValue(typeValue);
      }
      reactElement.type = expr;
    });
  }

  _serializeReactElementAttributes(reactElement: ReactElement): void {
    let { value } = reactElement;
    let keyValue = getProperty(this.realm, value, "key");
    let refValue = getProperty(this.realm, value, "ref");
    let propsValue = getProperty(this.realm, value, "props");

    if (keyValue !== this.realm.intrinsics.null && keyValue !== this.realm.intrinsics.undefined) {
      let reactElementKey = this._createReactElementAttribute();
      this._serializeNowOrAfterWaitingForDependencies(keyValue, reactElement, () => {
        let expr = this.residualHeapSerializer.serializeValue(keyValue);
        reactElementKey.expr = expr;
        reactElementKey.key = "key";
        reactElementKey.type = "PROPERTY";
      });
      reactElement.attributes.push(reactElementKey);
    }

    if (refValue !== this.realm.intrinsics.null && refValue !== this.realm.intrinsics.undefined) {
      let reactElementRef = this._createReactElementAttribute();
      this._serializeNowOrAfterWaitingForDependencies(refValue, reactElement, () => {
        let expr = this.residualHeapSerializer.serializeValue(refValue);
        reactElementRef.expr = expr;
        reactElementRef.key = "ref";
        reactElementRef.type = "PROPERTY";
      });
      reactElement.attributes.push(reactElementRef);
    }

    const assignPropsAsASpreadProp = () => {
      let reactElementSpread = this._createReactElementAttribute();
      this._serializeNowOrAfterWaitingForDependencies(propsValue, reactElement, () => {
        let expr = this.residualHeapSerializer.serializeValue(propsValue);
        reactElementSpread.expr = expr;
        reactElementSpread.type = "SPREAD";
      });
      reactElement.attributes.push(reactElementSpread);
    };

    // handle props
    if (propsValue instanceof AbstractValue) {
      assignPropsAsASpreadProp();
    } else if (propsValue instanceof ObjectValue) {
      if (propsValue.isPartialObject()) {
        assignPropsAsASpreadProp();
      } else {
        this.residualHeapSerializer.serializedValues.add(propsValue);
        for (let [propName, binding] of propsValue.properties) {
          if (binding.descriptor !== undefined && propName !== "children") {
            invariant(propName !== "key" && propName !== "ref", `"${propName}" is a reserved prop name`);
            let propValue = getProperty(this.realm, propsValue, propName);
            let reactElementAttribute = this._createReactElementAttribute();

            this._serializeNowOrAfterWaitingForDependencies(propValue, reactElement, () => {
              let expr = this.residualHeapSerializer.serializeValue(propValue);
              reactElementAttribute.expr = expr;
              reactElementAttribute.key = propName;
              reactElementAttribute.type = "PROPERTY";
            });
            reactElement.attributes.push(reactElementAttribute);
          }
        }
      }
    }
  }

  _serializeReactElementChildren(reactElement: ReactElement): void {
    let { value } = reactElement;
    let propsValue = getProperty(this.realm, value, "props");
    if (!(propsValue instanceof ObjectValue)) {
      return;
    }
    // handle children
    if (propsValue.properties.has("children")) {
      let childrenValue = getProperty(this.realm, propsValue, "children");
      this.residualHeapSerializer.serializedValues.add(childrenValue);

      if (childrenValue !== this.realm.intrinsics.undefined && childrenValue !== this.realm.intrinsics.null) {
        if (childrenValue instanceof ArrayValue) {
          let childrenLength = getProperty(this.realm, childrenValue, "length");
          let childrenLengthValue = 0;
          if (childrenLength instanceof NumberValue) {
            childrenLengthValue = childrenLength.value;
            for (let i = 0; i < childrenLengthValue; i++) {
              let child = getProperty(this.realm, childrenValue, "" + i);
              if (child instanceof Value) {
                reactElement.children.push(this._serializeReactElementChild(child, reactElement));
              } else {
                this.logger.logError(
                  value,
                  `ReactElement "props.children[${i}]" failed to serialize due to a non-value`
                );
              }
            }
          }
        } else {
          reactElement.children.push(this._serializeReactElementChild(childrenValue, reactElement));
        }
      }
    }
  }

  serializeReactElement(val: ObjectValue): BabelNodeExpression {
    let reactElement = this._createReactElement(val);

    this._serializeReactElementType(reactElement);
    this._serializeReactElementAttributes(reactElement);
    this._serializeReactElementChildren(reactElement);

    return this._emitReactElement(reactElement);
  }

  _addSerializedValueToJSXAttriutes(prop: string | null, expr: any, attributes: Array<BabelNode>): void {
    if (prop === null) {
      attributes.push(t.jSXSpreadAttribute(expr));
    } else {
      attributes.push(convertKeyValueToJSXAttribute(prop, expr));
    }
  }

  _serializeReactElementToCreateElement(
    val: ObjectValue,
    reactElement: ReactElement,
    createElementIdentifier: BabelNodeIdentifier
  ): BabelNodeExpression {
    let { type, attributes, children } = reactElement;

    let createElementArguments = [type];
    // check if we need to add attributes
    if (attributes.length !== 0) {
      let astAttributes = [];
      for (let attribute of attributes) {
        let expr = ((attribute.expr: any): BabelNodeExpression);

        if (attribute.type === "SPREAD") {
          astAttributes.push(t.spreadProperty(expr));
        } else if (attribute.type === "PROPERTY") {
          let attributeKey = attribute.key;
          let key;

          invariant(typeof attributeKey === "string");
          if (attributeKey.includes("-")) {
            key = t.stringLiteral(attributeKey);
          } else {
            key = t.identifier(attributeKey);
          }
          astAttributes.push(t.objectProperty(key, expr));
        }
      }
      createElementArguments.push(t.objectExpression(astAttributes));
    }
    if (children.length !== 0) {
      if (attributes.length === 0) {
        createElementArguments.push(t.nullLiteral());
      }
      let astChildren = [];
      for (let child of children) {
        let expr = ((child.expr: any): BabelNodeExpression);

        if (child.type === "NORMAL") {
          astChildren.push(expr);
        }
      }
      createElementArguments.push(...astChildren);
    }
    // cast to any for createElementArguments as casting it to BabelNodeExpresion[] isn't working
    let createElementCall = t.callExpression(createElementIdentifier, (createElementArguments: any));
    this._addBailOutMessageToBabelNode(val, createElementCall);
    return createElementCall;
  }

  _serializeReactElementToJSXElement(val: ObjectValue, reactElement: ReactElement): BabelNodeExpression {
    let { type, attributes, children } = reactElement;

    let jsxTypeIdentifer = convertExpressionToJSXIdentifier(((type: any): BabelNodeIdentifier), true);
    let astAttributes = [];
    for (let attribute of attributes) {
      let expr = ((attribute.expr: any): BabelNodeExpression);

      if (attribute.type === "SPREAD") {
        astAttributes.push(t.jSXSpreadAttribute(expr));
      } else if (attribute.type === "PROPERTY") {
        let attributeKey = attribute.key;
        invariant(typeof attributeKey === "string");
        astAttributes.push(convertKeyValueToJSXAttribute(attributeKey, expr));
      }
    }

    let astChildren = [];
    for (let child of children) {
      let expr = ((child.expr: any): BabelNodeExpression);

      if (child.type === "NORMAL") {
        if (t.isStringLiteral(expr) || t.isNumericLiteral(expr)) {
          astChildren.push(t.jSXText(((expr: any).value: string) + ""));
        } else if (t.isJSXElement(expr)) {
          astChildren.push(expr);
        } else {
          astChildren.push(t.jSXExpressionContainer(expr));
        }
      }
    }

    let openingElement = t.jSXOpeningElement(jsxTypeIdentifer, (astAttributes: any), astChildren.length === 0);
    let closingElement = t.jSXClosingElement(jsxTypeIdentifer);
    let jsxElement = t.jSXElement(openingElement, closingElement, astChildren, astChildren.length === 0);
    this._addBailOutMessageToBabelNode(val, jsxElement);
    return jsxElement;
  }

  _addBailOutMessageToBabelNode(val: ObjectValue, node: BabelNode): void {
    // if there has been a bail-out, we create an inline BlockComment node before the JSX element
    if (val.$BailOutReason !== undefined) {
      // $BailOutReason contains an optional string of what to print out in the comment
      node.leadingComments = [({ type: "BlockComment", value: `${val.$BailOutReason}` }: any)];
    }
  }

  _serializeReactElementChild(child: Value, reactElement: ReactElement): ReactElementChild {
    let reactElementChild = this._createReactElementChild();
    this._serializeNowOrAfterWaitingForDependencies(child, reactElement, () => {
      let expr = this.residualHeapSerializer.serializeValue(child);

      reactElementChild.expr = expr;
      reactElementChild.type = "NORMAL";
    });
    return reactElementChild;
  }

  serializeLazyHoistedNodes() {
    const entries = [];
    if (this._lazilyHoistedNodes !== undefined) {
      let { id, nodes, createElementIdentifier } = this._lazilyHoistedNodes;
      // create a function that initializes all the hoisted nodes
      let func = t.functionExpression(
        null,
        // use createElementIdentifier if it's not null
        createElementIdentifier ? [createElementIdentifier] : [],
        t.blockStatement(nodes.map(node => t.expressionStatement(t.assignmentExpression("=", node.id, node.astNode))))
      );
      // push it to the mainBody of the module
      entries.push(t.variableDeclaration("var", [t.variableDeclarator(id, func)]));
      // output all the empty variable declarations that will hold the nodes lazily
      entries.push(...nodes.map(node => t.variableDeclaration("var", [t.variableDeclarator(node.id)])));
      // reset the _lazilyHoistedNodes so other additional functions work
      this._lazilyHoistedNodes = undefined;
    }
    return entries;
  }
}