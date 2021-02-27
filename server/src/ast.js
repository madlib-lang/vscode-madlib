const NodeType = Object.freeze({
  Variable: "Variable",
  LiteralNumber: "LiteralNumber",
  LiteralString: "LiteralString",
  LiteralBoolean: "LiteralBoolean",
  LiteralUnit: "LiteralUnit",
  Abstraction: "Abstraction",
  AbstractionParameter: "AbstractionParameter",
  Application: "Application",
  TypedExpression: "TypedExpression",
  Export: "Export",
  Assignment: "Assignment",
  FieldAccess: "FieldAccess",
  If: "If",
  Where: "Where",
  NamespaceAccess: "NamespaceAccess",
  Placeholder: "Placeholder",
  TemplateString: "TemplateString",
  TupleConstructor: "TupleConstructor",
  ListConstructor: "ListConstructor",
  Record: "Record",
  JSExpression: "JSExpression",
});

module.exports = {
  NodeType,
};
