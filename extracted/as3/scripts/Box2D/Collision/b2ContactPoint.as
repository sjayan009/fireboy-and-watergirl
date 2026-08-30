package Box2D.Collision
{
   import Box2D.Collision.Shapes.b2Shape;
   import Box2D.Common.Math.b2Vec2;
   
   public class b2ContactPoint
   {
      
      public var separation:Number;
      
      public var normal:b2Vec2 = new b2Vec2();
      
      public var position:b2Vec2 = new b2Vec2();
      
      public var restitution:Number;
      
      public var shape1:b2Shape;
      
      public var shape2:b2Shape;
      
      public var id:b2ContactID = new b2ContactID();
      
      public var friction:Number;
      
      public var velocity:b2Vec2 = new b2Vec2();
      
      public function b2ContactPoint()
      {
         super();
      }
   }
}

